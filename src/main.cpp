#include <Arduino.h>
#include <SPI.h>
#include <radio.h>
#include <printf.h> // RF24's printPrettyDetails() uses printf()

// ---------------------------------------------------------------------------
// Xiaomi light bar controller for RF-Nano / Arduino Nano + nRF24L01+.
//
//   ?          this help
//   p          print radio details
//   s [sec]    scan for the remote, dump raw + decoded packets (default 15 s)
//   i <hex>    set remote id, e.g. "i 01B960"
//   o          on / off toggle
//   u / d      brightness higher / lower
//   c / w      colour temperature cooler / warmer
//   r          reset (medium brightness, warm)
//   x <hex>    send a raw command code, e.g. "x 0405"
//   b <0-15>   set brightness
//   t <0-15>   set colour temperature
//   a <0|1>    transmit on all four hopping channels (default 1)
//   n <1-255>  burst repetitions per channel (default 20)
// ---------------------------------------------------------------------------

#define SERIAL_BAUD 115200

static uint32_t remoteId = 0x01B960; // replace with your own ("s" prints it)
static uint8_t counter = 0;

// --- helpers ---------------------------------------------------------------

static void printHex(const uint8_t *d, uint8_t n)
{
	for (uint8_t i = 0; i < n; i++)
	{
		if (d[i] < 0x10)
		{
			Serial.print('0');
		}
		Serial.print(d[i], HEX);
	}
}

static bool isHexDigit(char c)
{
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static uint8_t hexVal(char c)
{
	if (c >= '0' && c <= '9')
		return c - '0';
	if (c >= 'a' && c <= 'f')
		return c - 'a' + 10;
	return c - 'A' + 10;
}

static uint32_t parseHex(const char *s)
{
	while (*s == ' ')
		s++;
	if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
		s += 2;

	uint32_t v = 0;
	while (isHexDigit(*s))
	{
		v = (v << 4) | hexVal(*s++);
	}
	return v;
}

// First argument as a decimal number, or -1.
static int parseDec(const char *s)
{
	while (*s == ' ')
		s++;
	if (*s < '0' || *s > '9')
		return -1;

	int v = 0;
	while (*s >= '0' && *s <= '9')
	{
		v = v * 10 + (*s++ - '0');
		if (v > 32000)
			break;
	}
	return v;
}

static void sendCommand(uint16_t command, const __FlashStringHelper *label)
{
	counter++; // the bar drops repeated counters

	Serial.print(F("tx "));
	Serial.print(label);
	Serial.print(F("  id="));
	uint8_t idBytes[3] = {(uint8_t)(remoteId >> 16), (uint8_t)(remoteId >> 8), (uint8_t)remoteId};
	printHex(idBytes, 3);
	Serial.print(F("  cmd=0x"));
	uint8_t cmdBytes[2] = {(uint8_t)(command >> 8), (uint8_t)command};
	printHex(cmdBytes, 2);
	Serial.print(F("  counter="));
	Serial.println(counter);

	uint16_t ok = lbSend(remoteId, command, counter);
	Serial.print(F("sent "));
	Serial.print(ok, DEC);
	Serial.print('/');
	Serial.println((uint16_t)lbChannelCount() * lbRepeats(), DEC);
}

// Two-step absolute setters, as used by the reverse-engineered library:
// overshoot past the end (step > 15) so nothing moves, then move back.
static void setBrightness(uint8_t value)
{
	if (value > 15)
		value = 15;
	counter++;
	lbSend(remoteId, 0x0500 - 16, counter); // saturate to lowest, deferred
	delay(60);
	counter++;
	lbSend(remoteId, 0x0400 + value, counter);
}

static void setColorTemp(uint8_t value)
{
	if (value > 15)
		value = 15;
	counter++;
	lbSend(remoteId, 0x0300 - 16, counter); // saturate to warmest, deferred
	delay(60);
	counter++;
	lbSend(remoteId, 0x0200 + value, counter);
}

// --- scan ------------------------------------------------------------------

static void doScan(uint16_t seconds)
{
	if (!radioIsReady())
	{
		Serial.println(F("no radio"));
		return;
	}

	radioRxSetup();
	Serial.print(F("scanning "));
	Serial.print(seconds);
	Serial.println(F(" s -- press / turn the remote knob now"));

	uint16_t seen = 0;
	uint16_t good = 0;
	uint32_t deadline = millis() + (uint32_t)seconds * 1000UL;

	while ((int32_t)(deadline - millis()) > 0)
	{
		uint8_t raw[LB_SCAN_PAYLOAD];
		if (radioScanPoll(raw))
		{
			seen++;
			uint8_t dec[9];
			bool ok = lbDecodeRaw(raw, dec);

			Serial.print(F("RX "));
			printHex(raw, LB_SCAN_PAYLOAD);
			if (ok)
			{
				good++;
				Serial.print(F("  CRC ok  id="));
				printHex(dec, 3);
				Serial.print(F("  counter="));
				Serial.print(dec[4], DEC);
				Serial.print(F("  cmd=0x"));
				printHex(dec + 5, 2);
			}
			else
			{
				Serial.print(F("  crc bad"));
			}
			Serial.println();
		}

		// Any keystroke aborts the scan.
		if (Serial.available())
		{
			while (Serial.available())
				Serial.read();
			break;
		}
	}

	Serial.print(F("scan done: "));
	Serial.print(seen, DEC);
	Serial.print(F(" packets, "));
	Serial.print(good, DEC);
	Serial.println(F(" with a valid crc"));

	radioTxSetup();
}

// --- command handling ------------------------------------------------------

static void printHelp()
{
	Serial.println(F("?  help          p  radio details"));
	Serial.println(F("s [sec]  scan for the remote"));
	Serial.println(F("i <hex>  set remote id"));
	Serial.println(F("o  on/off        r  reset"));
	Serial.println(F("u/d  brighter / dimmer"));
	Serial.println(F("c/w  cooler / warmer"));
	Serial.println(F("x <hex>  raw command code"));
	Serial.println(F("b <0-15> brightness   t <0-15> colour temp"));
	Serial.println(F("a <0|1>  all channels  n <1-255> repeats"));
	Serial.println(F("k <0-3>  PA level MIN/LOW/HIGH/MAX"));
}

static void handleLine(char *line)
{
	char *arg = line;
	while (*arg && *arg != ' ')
		arg++;
	if (*arg == ' ')
	{
		*arg++ = 0;
	}
	while (*arg == ' ')
		arg++;

	char cmd = line[0];

	switch (cmd)
	{
	case '?':
	case 'h':
		printHelp();
		break;

	case 'p':
		Serial.print(F("CE=D"));
		Serial.print(radioCePin(), DEC);
		Serial.print(F(" CSN=D"));
		Serial.println(radioCsnPin(), DEC);
		radioPrintDetails();
		break;

	case 's':
	{
		int secs = parseDec(arg);
		doScan(secs > 0 ? (uint16_t)secs : 15);
		break;
	}

	case 'i':
		remoteId = parseHex(arg) & 0xFFFFFF;
		Serial.print(F("remote id = 0x"));
		{
			uint8_t b[3] = {(uint8_t)(remoteId >> 16), (uint8_t)(remoteId >> 8), (uint8_t)remoteId};
			printHex(b, 3);
		}
		Serial.println();
		break;

	case 'o':
		sendCommand(LB_CMD_ON_OFF, F("on/off"));
		break;
	case 'r':
		sendCommand(LB_CMD_RESET, F("reset"));
		break;
	case 'u':
		sendCommand(LB_CMD_HIGHER, F("brighter"));
		break;
	case 'd':
		sendCommand(LB_CMD_LOWER, F("dimmer"));
		break;
	case 'c':
		sendCommand(LB_CMD_COOLER, F("cooler"));
		break;
	case 'w':
		sendCommand(LB_CMD_WARMER, F("warmer"));
		break;

	case 'x':
		sendCommand((uint16_t)parseHex(arg), F("raw"));
		break;

	case 'b':
	{
		int v = parseDec(arg);
		if (v >= 0)
		{
			setBrightness((uint8_t)v);
			Serial.println(F("brightness set"));
		}
		break;
	}

	case 't':
	{
		int v = parseDec(arg);
		if (v >= 0)
		{
			setColorTemp((uint8_t)v);
			Serial.println(F("colour temp set"));
		}
		break;
	}

	case 'k':
	{
		int v = parseDec(arg);
		if (v >= 0)
		{
			static const char *names[] = {"MIN", "LOW", "HIGH", "MAX"};
			uint8_t lvl = (uint8_t)(v > 3 ? 3 : v);
			lbSetPaLevel(lvl);
			Serial.print(F("PA level = "));
			Serial.println(names[lvl]);
		}
		break;
	}

	case 'a':
	{
		int v = parseDec(arg);
		bool on = (v != 0);
		lbSetAllChannels(on);
		Serial.print(F("all channels = "));
		Serial.println(on ? F("yes") : F("no"));
		break;
	}

	case 'n':
	{
		int v = parseDec(arg);
		if (v >= 1)
		{
			lbSetRepeats((uint8_t)v);
		}
		Serial.print(F("repeats = "));
		Serial.println(v >= 1 ? v : 20);
		break;
	}

	default:
		Serial.println(F("? for help"));
		break;
	}
}

// --- Arduino entry points --------------------------------------------------

static char lineBuf[48];
static uint8_t lineLen = 0;

void setup()
{
	Serial.begin(SERIAL_BAUD);
	printf_begin(); // redirect stdout so RF24's register dump reaches the port

	Serial.println();
	Serial.println(F("xiaomi lightbar controller"));

	if (radioProbe())
	{
		Serial.print(F("radio found: CE=D"));
		Serial.print(radioCePin(), DEC);
		Serial.print(F(", CSN=D"));
		Serial.println(radioCsnPin(), DEC);
		radioTxSetup();
	}
	else
	{
		Serial.println(F("RADIO NOT DETECTED - check the module"));
	}

	Serial.print(F("remote id = 0x"));
	{
		uint8_t b[3] = {(uint8_t)(remoteId >> 16), (uint8_t)(remoteId >> 8), (uint8_t)remoteId};
		printHex(b, 3);
	}
	Serial.println(F("  ('s' to scan, '?' for help)"));
	Serial.println(F("READY"));
}

void loop()
{
	while (Serial.available())
	{
		char c = Serial.read();
		if (c == '\r')
		{
			continue;
		}
		if (c == '\n')
		{
			lineBuf[lineLen] = 0;
			if (lineLen > 0)
			{
				handleLine(lineBuf);
			}
			lineLen = 0;
			// Completion sentinel: the host GUI waits for this before sending
			// the next command, so it never has to guess at a delay. A bare
			// newline is therefore also a valid "are you alive?" ping.
			Serial.println(F("READY"));
		}
		else if (lineLen < sizeof(lineBuf) - 1)
		{
			lineBuf[lineLen++] = c;
		}
	}
}
