#include <Arduino.h>
#include <SPI.h>
#include <RF24.h>

#include "radio.h"

// --- constants -------------------------------------------------------------

static const uint8_t LB_PREAMBLE[8] = {0x53, 0x39, 0x14, 0xDD, 0x1C, 0x49, 0x34, 0x12};

// 0b0101... : extends the Telink sync sequence in front of the payload.
static const uint8_t LB_TX_ADDR[5] = {0x55, 0x55, 0x55, 0x55, 0x55};

// First 5 bytes of the preamble, i.e. `preamble >> 24`. The bar's own
// transmissions start with the sync sequence, so this is what we match on.
static const uint8_t LB_RX_ADDR[5] = {0x53, 0x39, 0x14, 0xDD, 0x1C};

// Channels the bar hops over (MHz - 2400).
static const uint8_t LB_CHANNELS[4] = {6, 15, 43, 68};

// --- module state ----------------------------------------------------------

// One RF24 instance per known RF-Nano wiring; RF24 stores its pins at
// construction time and cannot be re-pointed afterwards.
static RF24 radioV1(10, 9);    // RF-Nano V1.0 / V2.0
static RF24 radioV3(9, 10);    // classic nRF24 wiring / some clones
static RF24 radioV3Alt(7, 8);  // RF-Nano V3.0

static RF24 *radio = nullptr;
static uint8_t activeCe = 0;
static uint8_t activeCsn = 0;

static uint8_t sRepeats = 20;
static bool sAllChannels = true;
static uint8_t sPaLevel = RF24_PA_MAX;

// --- bring-up --------------------------------------------------------------

bool radioProbe()
{
	struct
	{
		RF24 *dev;
		uint8_t ce;
		uint8_t csn;
		const char *label;
	} candidates[] = {
		{&radioV1, 10, 9, "RF-Nano V1/V2 (CE=D10, CSN=D9)"},
		{&radioV3, 9, 10, "classic (CE=D9, CSN=D10)"},
		{&radioV3Alt, 7, 8, "RF-Nano V3 (CE=D7, CSN=D8)"},
	};

	for (uint8_t i = 0; i < 3; i++)
	{
		RF24 *dev = candidates[i].dev;

		dev->begin();
		if (!dev->isChipConnected())
		{
			continue;
		}

		// Extra confidence: write a register and read it back.
		dev->setChannel(LB_CHANNEL);
		if (dev->getChannel() != LB_CHANNEL)
		{
			continue;
		}

		radio = dev;
		activeCe = candidates[i].ce;
		activeCsn = candidates[i].csn;
		return true;
	}

	radio = nullptr;
	return false;
}

uint8_t radioCePin() { return activeCe; }
uint8_t radioCsnPin() { return activeCsn; }
bool radioIsReady() { return radio != nullptr; }

void radioPrintDetails()
{
	if (!radio)
	{
		Serial.println(F("no radio detected"));
		return;
	}
	radio->printPrettyDetails();
}

// --- mode configuration ----------------------------------------------------

static void radioApplyBase()
{
	radio->setAddressWidth(LB_ADDRESS_WIDTH);
	radio->setDataRate(RF24_2MBPS); // the light bar runs at 2 Mbps
	radio->setPALevel(sPaLevel);    // close range is plenty by default
	radio->setChannel(LB_CHANNEL);
	radio->disableCRC();        // the bar's own CRC16 lives inside the payload
	radio->disableDynamicPayloads();
	radio->setAutoAck(false);   // nothing on the other end speaks nRF24
	radio->setRetries(0, 0);
}

void radioTxSetup()
{
	if (!radio)
	{
		return;
	}
	radio->stopListening();
	radioApplyBase();
	radio->setPayloadSize(LB_PAYLOAD_SIZE);
	radio->openWritingPipe((const uint8_t *)LB_TX_ADDR);
	radio->stopListening();
}

void radioRxSetup()
{
	if (!radio)
	{
		return;
	}
	radio->stopListening();
	radioApplyBase();
	radio->setPayloadSize(LB_SCAN_PAYLOAD);
	radio->openReadingPipe(1, (const uint8_t *)LB_RX_ADDR);
	radio->startListening();
}

// --- baseband --------------------------------------------------------------

uint16_t crc16(const uint8_t *data, uint8_t len)
{
	uint16_t crc = 0xFFFE;
	for (uint8_t i = 0; i < len; i++)
	{
		crc ^= (uint16_t)data[i] << 8;
		for (uint8_t bit = 0; bit < 8; bit++)
		{
			crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021)
								 : (uint16_t)(crc << 1);
		}
	}
	return crc;
}

void lbBuildPacket(uint8_t *out, uint32_t remoteId, uint16_t command, uint8_t counter)
{
	memcpy(out, LB_PREAMBLE, 8);
	out[8] = (remoteId >> 16) & 0xFF;
	out[9] = (remoteId >> 8) & 0xFF;
	out[10] = remoteId & 0xFF;
	out[11] = 0xFF; // separator
	out[12] = counter;
	out[13] = (command >> 8) & 0xFF;
	out[14] = command & 0xFF;

	uint16_t crc = crc16(out, 15);
	out[15] = (crc >> 8) & 0xFF;
	out[16] = crc & 0xFF;
}

// Bit `p` (0 = least significant) of a big-endian byte array.
static uint8_t bitAt(const uint8_t *raw, uint8_t nbytes, uint8_t p)
{
	uint8_t idx = (uint8_t)(nbytes - 1 - (p >> 3));
	return (raw[idx] >> (p & 7)) & 1;
}

// Eight bits starting at `startBit`, most significant first.
static uint8_t extractByteBE(const uint8_t *raw, uint8_t nbytes, uint8_t startBit)
{
	uint8_t v = 0;
	for (uint8_t i = 0; i < 8; i++)
	{
		v = (uint8_t)((v << 1) | bitAt(raw, nbytes, startBit + 7 - i));
	}
	return v;
}

bool lbDecodeRaw(const uint8_t *raw12, uint8_t *out9)
{
	// The nRF24 payload is bit-shifted relative to the Telink fields: the nine
	// meaningful bytes are bits [9, 81) of the 96-bit big-endian value.
	for (uint8_t j = 0; j < 9; j++)
	{
		out9[j] = extractByteBE(raw12, LB_SCAN_PAYLOAD, (uint8_t)(9 + (8 - j) * 8));
	}

	uint8_t buf[15];
	memcpy(buf, LB_PREAMBLE, 8);
	memcpy(buf + 8, out9, 7); // id(3) + separator + counter + command(2)

	uint16_t expected = crc16(buf, 15);
	uint16_t actual = ((uint16_t)out9[7] << 8) | out9[8];
	return expected == actual;
}

// --- transmit --------------------------------------------------------------

void lbSetRepeats(uint8_t repeats)
{
	if (repeats >= 1)
	{
		sRepeats = repeats;
	}
}

uint8_t lbRepeats() { return sRepeats; }
uint8_t lbChannelCount() { return sAllChannels ? 4 : 1; }

void lbSetAllChannels(bool on) { sAllChannels = on; }

void lbSetPaLevel(uint8_t level)
{
	sPaLevel = (level > 3) ? 3 : level;
	if (radio)
	{
		radio->setPALevel(sPaLevel);
	}
}

uint8_t lbPaLevel() { return sPaLevel; }

// Reports how many radio writes reported a completed transmission. A healthy
// nRF24 with auto-ack off sets TX_DS for every packet it puts on the air, so a
// full count only proves the SPI/radio side is alive, not that the light bar
// heard anything.
uint16_t lbSend(uint32_t remoteId, uint16_t command, uint8_t counter)
{
	if (!radio)
	{
		return 0;
	}

	uint8_t pkt[LB_PAYLOAD_SIZE];
	lbBuildPacket(pkt, remoteId, command, counter);

	uint8_t channels = sAllChannels ? 4 : 1;
	uint16_t ok = 0;

	radio->stopListening();
	radio->setPayloadSize(LB_PAYLOAD_SIZE);
	radio->openWritingPipe((const uint8_t *)LB_TX_ADDR);

	for (uint8_t c = 0; c < channels; c++)
	{
		radio->setChannel(LB_CHANNELS[c]);
		for (uint8_t r = 0; r < sRepeats; r++)
		{
			if (radio->write(pkt, LB_PAYLOAD_SIZE))
			{
				ok++;
			}
			delay(10);
		}
	}

	radio->setChannel(LB_CHANNEL);
	return ok;
}

// --- receive ---------------------------------------------------------------

bool radioScanPoll(uint8_t *raw12)
{
	if (!radio || !radio->available())
	{
		return false;
	}
	radio->read(raw12, LB_SCAN_PAYLOAD);
	return true;
}
