#pragma once

// MJPEG-over-HTTP streamer on port 81 — the only camera video transport.
// multipart/x-mixed-replace over TCP; no signaling, no NAT traversal.

void http_stream_init(void);
