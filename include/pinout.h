#pragma once

// ---------------------------------------------------------------------------
// RF-Nano (emakefun) on-board nRF24L01+ wiring
// ---------------------------------------------------------------------------
// The RF-Nano has the nRF24L01+ soldered on the board, so CE/CSN are fixed by
// the PCB revision and DIFFER between revisions:
//
//   RF-Nano V1.0 / V2.0 : CE = D10, CSN = D9   <-- "not compatible with RF24
//                                                  library (10, 9, 11, 12, 13)"
//   RF-Nano V3.0        : CE = D7,  CSN = D8   (RF24 default 9/10 also present
//                                               as a fallback on some clones)
//
// Source: https://github.com/emakefun/rf-nano  (README, pin connection table)
//
// MOSI/MISO/SCK are the hardware SPI pins on every revision:
//   D11 = MOSI, D12 = MISO, D13 = SCK
//
// radio.cpp probes all of the pairs below at runtime, so you normally do not
// need to touch this file. It is only used for the preferred/default pair.
// ---------------------------------------------------------------------------

#define PIN_RADIO_CE  10
#define PIN_RADIO_CSN 9
