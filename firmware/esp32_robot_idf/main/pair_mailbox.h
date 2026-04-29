#pragma once

#include <stddef.h>
#include <stdint.h>

// Phone↔desktop pair signaling, relayed through the robot's BLE GATT
// service. Both clients connect to the robot via Web Bluetooth, write
// signed ads to PAIR_MAILBOX_CHAR_UUID, and subscribe for notifies. The
// robot stores the last N ads in a ring buffer and:
//   - on WRITE: broadcasts the ad to every OTHER connected subscriber
//     so the peer (phone or desktop) sees it without coordination
//   - on SUBSCRIBE: replays the buffered ads to the new subscriber so
//     a late-joiner picks up offers/answers that flew while it was
//     still connecting
//
// Robot is a dumb relay — does NOT validate signatures. Trust comes
// from the signed-envelope protocol (peer-key.js) the consumers
// already use over signal.neevs.io's discover lobby. Same wire format,
// different transport.
//
// Replaces signal.neevs.io's discover lobby for the co-located case
// (phone + desktop both in BLE range of the robot). Cross-network
// phone-pair stays on signal.neevs.io.

void pair_mailbox_init(void);

// Called by gatt_svr from the PAIR_MAILBOX_CHAR_UUID write callback.
// `from_conn` is the BLE conn handle of the writer; the broadcast skips
// it so writers don't echo their own ads.
void pair_mailbox_handle_write(uint16_t from_conn, const uint8_t *buf, size_t len);

// Called by ble_host from BLE_GAP_EVENT_SUBSCRIBE when a peer enables
// notifications on the mailbox char. Replays the ring buffer so the new
// subscriber sees ads it would have missed during connect setup.
void pair_mailbox_replay_to(uint16_t conn_handle);
