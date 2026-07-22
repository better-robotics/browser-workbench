/* MicroPython embed config for the on-robot VM (issue #47). Committed; drives
 * qstr generation in tools/gen-micropython.sh AND compilation of the generated
 * tree, so the two can't disagree. Kept close to the stock embed minimum for a
 * first, reliable integration — float/asyncio/extra modules come after the VM
 * is validated on S3 hardware.
 */
#include <port/mpconfigport_common.h>

#define MICROPY_CONFIG_ROM_LEVEL                (MICROPY_CONFIG_ROM_LEVEL_MINIMUM)

#define MICROPY_ENABLE_COMPILER                 (1)
#define MICROPY_ENABLE_GC                       (1)
#define MICROPY_PY_GC                           (1)
#define MICROPY_PY_SYS                          (0)

// setjmp-based non-local returns + GC register scan — the embed port ships no
// hand-written Xtensa asm for either, so force the portable paths (a jmp_buf
// captures the callee-saved registers the GC must trace) for esp32s3.
#define MICROPY_NLR_SETJMP                      (1)
#define MICROPY_GCREGS_SETJMP                   (1)

// Useful student tracebacks over the wire: exception messages + line numbers.
#define MICROPY_ERROR_REPORTING                 (MICROPY_ERROR_REPORTING_NORMAL)
#define MICROPY_ENABLE_SOURCE_LINE              (1)
