# ESP-IDF project — esp32_robot.
#
# Migration from firmware/esp32_robot/esp32_robot.ino (Arduino single-file
# sketch). Lives in parallel during the migration; the Arduino project stays
# the shipping firmware until this one is feature-complete and tested. See
# README.md in this directory for the migration arc.
#
# Target chip: classic ESP32 (AI-Thinker ESP32-CAM, the "MB" board) is the
# current target; camera streams MJPEG over HTTP. ESP32-S3 is a planned
# secondary target via the same build-time board flag.

cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(esp32_robot)
