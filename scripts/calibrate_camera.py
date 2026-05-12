"""
Camera calibration for the overhead CV localization system.

Prints a chessboard pattern (see assets/chessboard.pdf or generate one at
https://calib.io/pages/camera-calibration-pattern-generator), holds it at
various angles in front of the camera, and collects frames. Once you have
enough frames the script computes camera_matrix and dist_coeffs and writes
them to scripts/camera_calibration.json — used by the CV panel for Phase 2
metric pose estimation.

Usage:
    python scripts/calibrate_camera.py

Controls:
    SPACE  — capture the current frame (only saved if corners are found)
    Q      — quit and run calibration with collected frames
    ESC    — abort without saving

Options (edit below):
    CAMERA_INDEX   — which camera to use (0 = default)
    BOARD_COLS     — inner corner count along the long edge of the board
    BOARD_ROWS     — inner corner count along the short edge
    SQUARE_SIZE_MM — physical size of one square in millimeters
    MIN_FRAMES     — minimum captures before calibration is allowed
    OUT_FILE       — where to write the calibration JSON
"""

import cv2
import numpy as np
import json
import os
import sys

CAMERA_INDEX   = 0
BOARD_COLS     = 9   # inner corners, long axis
BOARD_ROWS     = 6   # inner corners, short axis
SQUARE_SIZE_MM = 25  # measure your printed square — accuracy matters here
MIN_FRAMES     = 15
OUT_FILE       = os.path.join(os.path.dirname(__file__), "camera_calibration.json")

BOARD_SIZE = (BOARD_COLS, BOARD_ROWS)

# 3-D object points for one board: (0,0,0), (1,0,0), … in square units,
# then scaled by SQUARE_SIZE_MM so tvecs come out in mm.
objp = np.zeros((BOARD_COLS * BOARD_ROWS, 3), np.float32)
objp[:, :2] = np.mgrid[0:BOARD_COLS, 0:BOARD_ROWS].T.reshape(-1, 2)
objp *= SQUARE_SIZE_MM

obj_points = []  # 3-D world coords per accepted frame
img_points = []  # 2-D image coords per accepted frame

cap = cv2.VideoCapture(CAMERA_INDEX)
if not cap.isOpened():
    print(f"ERROR: could not open camera {CAMERA_INDEX}")
    sys.exit(1)

print(f"Camera {CAMERA_INDEX} opened.")
print(f"Board: {BOARD_COLS}×{BOARD_ROWS} inner corners, {SQUARE_SIZE_MM} mm squares.")
print("Hold the chessboard at different angles and distances.")
print("  SPACE  — capture frame   Q — finish & calibrate   ESC — abort")
print()

criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)

while True:
    ret, frame = cap.read()
    if not ret:
        print("ERROR: failed to read frame")
        break

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    found, corners = cv2.findChessboardCorners(gray, BOARD_SIZE, None)

    display = frame.copy()
    if found:
        cv2.drawChessboardCorners(display, BOARD_SIZE, corners, found)

    n = len(obj_points)
    color = (0, 200, 0) if found else (0, 80, 200)
    label = f"{'Board found' if found else 'No board'} | {n} frame{'s' if n != 1 else ''} captured"
    if n < MIN_FRAMES:
        label += f" (need {MIN_FRAMES - n} more)"
    cv2.putText(display, label, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2, cv2.LINE_AA)
    if n >= MIN_FRAMES:
        cv2.putText(display, "Press Q to calibrate", (10, 56),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 0), 1, cv2.LINE_AA)

    cv2.imshow("Calibration", display)
    key = cv2.waitKey(1) & 0xFF

    if key == ord("q") or key == ord("Q"):
        if n < MIN_FRAMES:
            print(f"Need at least {MIN_FRAMES} frames, only have {n}. Keep capturing.")
        else:
            break

    elif key == 27:  # ESC
        print("Aborted — no file written.")
        cap.release()
        cv2.destroyAllWindows()
        sys.exit(0)

    elif key == ord(" "):
        if not found:
            print("  No corners found in this frame — skipped.")
            continue
        refined = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)
        obj_points.append(objp)
        img_points.append(refined)
        print(f"  Frame {len(obj_points)} captured.")

cap.release()
cv2.destroyAllWindows()

print(f"\nCalibrating with {len(obj_points)} frames…")
h, w = gray.shape
rms, camera_matrix, dist_coeffs, rvecs, tvecs = cv2.calibrateCamera(
    obj_points, img_points, (w, h), None, None
)
print(f"RMS reprojection error: {rms:.4f} px  (< 1.0 is good, < 0.5 is excellent)")

result = {
    "camera_matrix": camera_matrix.tolist(),
    "dist_coeffs": dist_coeffs.tolist(),
    "image_size": [w, h],
    "rms_error": round(rms, 6),
    "board": {
        "cols": BOARD_COLS,
        "rows": BOARD_ROWS,
        "square_size_mm": SQUARE_SIZE_MM,
    },
    "frames_used": len(obj_points),
}

with open(OUT_FILE, "w") as f:
    json.dump(result, f, indent=2)

print(f"Saved to {OUT_FILE}")
print()
print("camera_matrix:")
print(np.array(result["camera_matrix"]))
print()
print("dist_coeffs:")
print(np.array(result["dist_coeffs"]))
