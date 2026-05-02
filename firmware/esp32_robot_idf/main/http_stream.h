#pragma once

// MJPEG-over-HTTP streamer on port 81. Re-added in 2026-05 as a
// comparison path for WebRTC video — same camera fb_get loop, no
// signaling / NAT / DTLS / SCTP, just multipart/x-mixed-replace over
// TCP. The dashboard's camera cap exposes a "Try HTTP" link that opens
// http://<ip>:81/stream in a new tab so HTTP and WebRTC can run
// side-by-side.

void http_stream_init(void);
