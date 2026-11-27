# macro_script.h is generated from payload.txt at build time; editing
# payload.txt and rebuilding is enough to update the macro.
find_package(Python3 REQUIRED COMPONENTS Interpreter)

set(CIV7_KEYBOARD_LAYOUT "us" CACHE STRING "Host keyboard layout: us or jis")
set_property(CACHE CIV7_KEYBOARD_LAYOUT PROPERTY STRINGS us jis)
set(CIV7_IME_OFF "none" CACHE STRING "Before each line: none or lang2 (experimental)")
set_property(CACHE CIV7_IME_OFF PROPERTY STRINGS none lang2)
option(CIV7_KEYBOARD_DIAGNOSTIC "Type plain text only, without gamepad or Enter" OFF)
set(CIV7_IME_START "none" CACHE STRING "JIS only: none, grave (first field), grave-each-line (every field)")
set_property(CACHE CIV7_IME_START PROPERTY STRINGS none grave grave-each-line)
if(NOT CIV7_IME_START MATCHES "^(none|grave|grave-each-line)$")
  message(FATAL_ERROR "CIV7_IME_START must be none, grave or grave-each-line")
endif()
set(CIV7_IME_PROBE "none" CACHE STRING "Diagnostic only: none, control, lang2, grave, alt-grave, shift-caps, muhenkan")
set_property(CACHE CIV7_IME_PROBE PROPERTY STRINGS none control lang2 grave alt-grave shift-caps muhenkan)
if(NOT CIV7_IME_PROBE MATCHES "^(none|control|lang2|grave|alt-grave|shift-caps|muhenkan)$")
  message(FATAL_ERROR "Invalid CIV7_IME_PROBE")
endif()
if(NOT CIV7_IME_PROBE STREQUAL "none")
  if(NOT CIV7_KEYBOARD_DIAGNOSTIC OR NOT CIV7_IME_OFF STREQUAL "none")
    message(FATAL_ERROR "IME probes require diagnostic mode and CIV7_IME_OFF=none")
  endif()
endif()
if(NOT CIV7_IME_START STREQUAL "none")
  if(NOT CIV7_KEYBOARD_LAYOUT STREQUAL "jis" OR NOT CIV7_IME_OFF STREQUAL "none" OR NOT CIV7_IME_PROBE STREQUAL "none")
    message(FATAL_ERROR "CIV7_IME_START requires JIS layout, IME_OFF=none and IME_PROBE=none")
  endif()
endif()
set(CIV7_PAYLOAD_FILE "${PROJECT_SOURCE_DIR}/payload.txt" CACHE FILEPATH "Text input file")
if(NOT CIV7_KEYBOARD_LAYOUT MATCHES "^(us|jis)$")
  message(FATAL_ERROR "CIV7_KEYBOARD_LAYOUT must be us or jis")
endif()
if(NOT CIV7_IME_OFF MATCHES "^(none|lang2)$")
  message(FATAL_ERROR "CIV7_IME_OFF must be none or lang2")
endif()

set(PAYLOAD_FILE "${CIV7_PAYLOAD_FILE}")
# Keep generated headers separate for each board/layout/diagnostic build.
set(MACRO_SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/generated/macro_script.h")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/generated")
set(MACRO_ARGS --layout ${CIV7_KEYBOARD_LAYOUT} --ime-off ${CIV7_IME_OFF} --ime-probe ${CIV7_IME_PROBE} --ime-start ${CIV7_IME_START})
set(MACRO_DEPS "${PAYLOAD_FILE}")
if(CIV7_KEYBOARD_DIAGNOSTIC)
  list(APPEND MACRO_ARGS --diagnostic)
  set(MACRO_DEPS "")
endif()
# A changed cache option must also regenerate the header on Makefile builds.
file(CONFIGURE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/macro_options.txt"
  CONTENT "@CIV7_KEYBOARD_LAYOUT@\n@CIV7_IME_OFF@\n@CIV7_KEYBOARD_DIAGNOSTIC@\n@CIV7_IME_PROBE@\n@CIV7_IME_START@\n@PAYLOAD_FILE@\n" @ONLY)

add_custom_command(
  OUTPUT ${MACRO_SCRIPT}
  COMMAND ${Python3_EXECUTABLE} ${PROJECT_SOURCE_DIR}/tools/payload_to_macro.py "${PAYLOAD_FILE}" "${MACRO_SCRIPT}" ${MACRO_ARGS}
  DEPENDS ${MACRO_DEPS} ${PROJECT_SOURCE_DIR}/tools/payload_to_macro.py
          "${CMAKE_CURRENT_BINARY_DIR}/macro_options.txt"
  COMMENT "Generating macro_script.h from payload.txt"
  VERBATIM
)

add_library(macro MacroEngine.cpp ${MACRO_SCRIPT})
target_link_libraries(macro pico_stdlib hardware_pio tinyusb_device)
target_include_directories(macro BEFORE PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
target_include_directories(macro PUBLIC ${PROJECT_SOURCE_DIR}/include)
