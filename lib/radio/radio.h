#ifndef RADIO_H
#define RADIO_H

#include <stdint.h>

// ---------------------------------------------------------------------------
// Xiaomi Mi Computer Monitor Light Bar, model MJGJD01YL (Telink TLSR8368).
//
// Baseband packet (17 bytes):
//   preamble   8 bytes  53 39 14 DD 1C 49 34 12   (fixed)
//   remote id  3 bytes  hardcoded in the remote
//   separator  1 byte   FF
//   counter    1 byte   increments per command; a repeated value is ignored
//   command    2 bytes  see lbCmd* below
//   crc16      2 bytes  poly 0x1021, init 0xFFFE, no reflection, xorout 0
//
// The nRF24 transmits  preamble + address + payload, so filling the 5-byte
// address with 0x55 (0b0101...) extends the Telink sync sequence and the
// 17-byte packet rides along as the payload.
//
// Protocol reverse engineered by lamperez:
//   https://github.com/lamperez/xiaomi-lightbar-nrf24
// ---------------------------------------------------------------------------

#define LB_CHANNEL        6   // 2406 MHz; the bar also hops over 15, 43, 68
#define LB_PAYLOAD_SIZE   17
#define LB_SCAN_PAYLOAD   12  // 3 trailing preamble bytes + the 9 real ones
#define LB_ADDRESS_WIDTH  5

// Command codes (from the reverse engineering)
#define LB_CMD_ON_OFF     0x0100
#define LB_CMD_COOLER     0x0201  // 0x0200 + step (1..15)
#define LB_CMD_WARMER     0x03FF  // 0x0300 - step
#define LB_CMD_HIGHER     0x0401  // 0x0400 + step
#define LB_CMD_LOWER      0x05FF  // 0x0500 - step
#define LB_CMD_RESET      0x0600

// --- radio bring-up --------------------------------------------------------
bool    radioProbe();      // find which CE/CSN pair the on-board module answers on
uint8_t radioCePin();
uint8_t radioCsnPin();
bool    radioIsReady();
void    radioPrintDetails();

// --- modes -----------------------------------------------------------------
void radioTxSetup();
void radioRxSetup();

// --- baseband --------------------------------------------------------------
uint16_t crc16(const uint8_t *data, uint8_t len);
void     lbBuildPacket(uint8_t *out17, uint32_t remoteId, uint16_t command, uint8_t counter);
bool     lbDecodeRaw(const uint8_t *raw12, uint8_t *decoded9);  // true when CRC matches

// --- transmit --------------------------------------------------------------
uint16_t lbSend(uint32_t remoteId, uint16_t command, uint8_t counter);
void     lbSetRepeats(uint8_t repeats);
uint8_t  lbRepeats();
uint8_t  lbChannelCount();
void     lbSetAllChannels(bool on);
void     lbSetPaLevel(uint8_t level); // 0=MIN 1=LOW 2=HIGH 3=MAX
uint8_t  lbPaLevel();

// --- receive ---------------------------------------------------------------
bool radioScanPoll(uint8_t *raw12);

#endif
