#ifndef LIBRETRO_CORE_OPTIONS_INTL_H__
#define LIBRETRO_CORE_OPTIONS_INTL_H__

#if defined(_MSC_VER) && (_MSC_VER >= 1500 && _MSC_VER < 1900)
/* https://support.microsoft.com/en-us/kb/980263 */
#pragma execution_character_set("utf-8")
#pragma warning(disable:4566)
#endif

#include <libretro.h>

/*
 ********************************
 * VERSION: 2.0
 ********************************
 *
 * - 2.0: Add support for core options v2 interface
 * - 1.3: Move translations to libretro_core_options_intl.h
 *        - libretro_core_options_intl.h includes BOM and utf-8
 *          fix for MSVC 2010-2013
 *        - Added HAVE_NO_LANGEXTRA flag to disable translations
 *          on platforms/compilers without BOM support
 * - 1.2: Use core options v1 interface when
 *        RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION is >= 1
 *        (previously required RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION == 1)
 * - 1.1: Support generation of core options v0 retro_core_option_value
 *        arrays containing options with a single value
 * - 1.0: First commit
*/

#ifdef __cplusplus
extern "C" {
#endif

/*
 ********************************
 * Core Option Definitions
 ********************************
*/
/* RETRO_LANGUAGE_AR */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_AR "نسبة الجانب"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_AR NULL
#define OPTION_VAL_PAR_AR NULL
#define OPTION_VAL_4_3_AR NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_AR NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_AR NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_AR NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_AR NULL
#define QUICKNES_PALETTE_LABEL_AR NULL
#define QUICKNES_PALETTE_INFO_0_AR NULL
#define OPTION_VAL_DEFAULT_AR NULL
#define OPTION_VAL_ASQREALC_AR NULL
#define OPTION_VAL_NINTENDO_VC_AR NULL
#define OPTION_VAL_RGB_AR NULL
#define OPTION_VAL_YUV_V3_AR NULL
#define OPTION_VAL_UNSATURATED_FINAL_AR NULL
#define OPTION_VAL_SONY_CXA2025AS_US_AR NULL
#define OPTION_VAL_PAL_AR NULL
#define OPTION_VAL_BMF_FINAL2_AR NULL
#define OPTION_VAL_BMF_FINAL3_AR NULL
#define OPTION_VAL_SMOOTH_FBX_AR NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_AR NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_AR NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_AR NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_AR NULL
#define OPTION_VAL_NESCAP_AR NULL
#define OPTION_VAL_WAVEBEAM_AR NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_AR NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_AR NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_AR NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_AR NULL
#define OPTION_VAL_NONLINEAR_AR NULL
#define OPTION_VAL_LINEAR_AR "خطي"
#define OPTION_VAL_STEREO_PANNING_AR NULL
#define QUICKNES_AUDIO_EQ_LABEL_AR NULL
#define QUICKNES_AUDIO_EQ_INFO_0_AR NULL
#define OPTION_VAL_FAMICOM_AR NULL
#define OPTION_VAL_TV_AR NULL
#define OPTION_VAL_FLAT_AR NULL
#define OPTION_VAL_CRISP_AR NULL
#define OPTION_VAL_TINNY_AR NULL
#define QUICKNES_TURBO_ENABLE_LABEL_AR NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_AR NULL
#define OPTION_VAL_NONE_AR "لاشيء"
#define OPTION_VAL_PLAYER_1_AR NULL
#define OPTION_VAL_PLAYER_2_AR NULL
#define OPTION_VAL_BOTH_AR NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_AR NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_AR NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_AR NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_AR NULL

struct retro_core_option_v2_category option_cats_ar[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_ar[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_AR,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_AR,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_AR },
         { "4:3", OPTION_VAL_4_3_AR },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_AR,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_AR,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_AR,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_AR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_AR,
      NULL,
      QUICKNES_PALETTE_INFO_0_AR,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_AR },
         { "asqrealc",             OPTION_VAL_ASQREALC_AR },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_AR },
         { "rgb",                  OPTION_VAL_RGB_AR },
         { "yuv-v3",               OPTION_VAL_YUV_V3_AR },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_AR },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_AR },
         { "pal",                  OPTION_VAL_PAL_AR },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_AR },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_AR },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_AR },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_AR },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_AR },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_AR },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_AR },
         { "nescap",               OPTION_VAL_NESCAP_AR },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_AR },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_AR,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_AR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_AR,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_AR,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_AR },
         { "linear",         OPTION_VAL_LINEAR_AR },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_AR },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_AR,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_AR,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_AR },
         { "famicom", OPTION_VAL_FAMICOM_AR },
         { "tv",      OPTION_VAL_TV_AR },
         { "flat",    OPTION_VAL_FLAT_AR },
         { "crisp",   OPTION_VAL_CRISP_AR },
         { "tinny",   OPTION_VAL_TINNY_AR },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_AR,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_AR,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_AR },
         { "player 1", OPTION_VAL_PLAYER_1_AR },
         { "player 2", OPTION_VAL_PLAYER_2_AR },
         { "both",     OPTION_VAL_BOTH_AR },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_AR,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_AR,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_AR,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_AR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_ar = {
   option_cats_ar,
   option_defs_ar
};

/* RETRO_LANGUAGE_AST */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_AST "Proporción d'aspeutu"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_AST NULL
#define OPTION_VAL_PAR_AST NULL
#define OPTION_VAL_4_3_AST NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_AST NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_AST NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_AST NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_AST NULL
#define QUICKNES_PALETTE_LABEL_AST NULL
#define QUICKNES_PALETTE_INFO_0_AST NULL
#define OPTION_VAL_DEFAULT_AST NULL
#define OPTION_VAL_ASQREALC_AST NULL
#define OPTION_VAL_NINTENDO_VC_AST NULL
#define OPTION_VAL_RGB_AST NULL
#define OPTION_VAL_YUV_V3_AST "YUV-V3 de FBX"
#define OPTION_VAL_UNSATURATED_FINAL_AST NULL
#define OPTION_VAL_SONY_CXA2025AS_US_AST NULL
#define OPTION_VAL_PAL_AST NULL
#define OPTION_VAL_BMF_FINAL2_AST NULL
#define OPTION_VAL_BMF_FINAL3_AST NULL
#define OPTION_VAL_SMOOTH_FBX_AST NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_AST NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_AST NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_AST NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_AST NULL
#define OPTION_VAL_NESCAP_AST NULL
#define OPTION_VAL_WAVEBEAM_AST NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_AST NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_AST NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_AST NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_AST NULL
#define OPTION_VAL_NONLINEAR_AST NULL
#define OPTION_VAL_LINEAR_AST NULL
#define OPTION_VAL_STEREO_PANNING_AST NULL
#define QUICKNES_AUDIO_EQ_LABEL_AST NULL
#define QUICKNES_AUDIO_EQ_INFO_0_AST NULL
#define OPTION_VAL_FAMICOM_AST NULL
#define OPTION_VAL_TV_AST NULL
#define OPTION_VAL_FLAT_AST NULL
#define OPTION_VAL_CRISP_AST NULL
#define OPTION_VAL_TINNY_AST NULL
#define QUICKNES_TURBO_ENABLE_LABEL_AST NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_AST NULL
#define OPTION_VAL_NONE_AST NULL
#define OPTION_VAL_PLAYER_1_AST "Xugador 1"
#define OPTION_VAL_PLAYER_2_AST "Xugador 2"
#define OPTION_VAL_BOTH_AST "Xugador 1 y 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_AST NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_AST NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_AST "Permitir les direiciones opuestes"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_AST NULL

struct retro_core_option_v2_category option_cats_ast[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_ast[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_AST,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_AST,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_AST },
         { "4:3", OPTION_VAL_4_3_AST },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_AST,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_AST,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_AST,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_AST,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_AST,
      NULL,
      QUICKNES_PALETTE_INFO_0_AST,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_AST },
         { "asqrealc",             OPTION_VAL_ASQREALC_AST },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_AST },
         { "rgb",                  OPTION_VAL_RGB_AST },
         { "yuv-v3",               OPTION_VAL_YUV_V3_AST },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_AST },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_AST },
         { "pal",                  OPTION_VAL_PAL_AST },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_AST },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_AST },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_AST },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_AST },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_AST },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_AST },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_AST },
         { "nescap",               OPTION_VAL_NESCAP_AST },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_AST },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_AST,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_AST,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_AST,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_AST,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_AST },
         { "linear",         OPTION_VAL_LINEAR_AST },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_AST },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_AST,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_AST,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_AST },
         { "famicom", OPTION_VAL_FAMICOM_AST },
         { "tv",      OPTION_VAL_TV_AST },
         { "flat",    OPTION_VAL_FLAT_AST },
         { "crisp",   OPTION_VAL_CRISP_AST },
         { "tinny",   OPTION_VAL_TINNY_AST },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_AST,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_AST,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_AST },
         { "player 1", OPTION_VAL_PLAYER_1_AST },
         { "player 2", OPTION_VAL_PLAYER_2_AST },
         { "both",     OPTION_VAL_BOTH_AST },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_AST,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_AST,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_AST,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_AST,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_ast = {
   option_cats_ast,
   option_defs_ast
};

/* RETRO_LANGUAGE_CA */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_CA "Relació d'aspecte"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_CA NULL
#define OPTION_VAL_PAR_CA NULL
#define OPTION_VAL_4_3_CA NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_CA NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_CA NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_CA NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_CA NULL
#define QUICKNES_PALETTE_LABEL_CA NULL
#define QUICKNES_PALETTE_INFO_0_CA NULL
#define OPTION_VAL_DEFAULT_CA NULL
#define OPTION_VAL_ASQREALC_CA NULL
#define OPTION_VAL_NINTENDO_VC_CA NULL
#define OPTION_VAL_RGB_CA NULL
#define OPTION_VAL_YUV_V3_CA NULL
#define OPTION_VAL_UNSATURATED_FINAL_CA NULL
#define OPTION_VAL_SONY_CXA2025AS_US_CA NULL
#define OPTION_VAL_PAL_CA NULL
#define OPTION_VAL_BMF_FINAL2_CA NULL
#define OPTION_VAL_BMF_FINAL3_CA NULL
#define OPTION_VAL_SMOOTH_FBX_CA NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_CA NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_CA NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_CA NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_CA NULL
#define OPTION_VAL_NESCAP_CA NULL
#define OPTION_VAL_WAVEBEAM_CA NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_CA NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_CA NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_CA NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_CA NULL
#define OPTION_VAL_NONLINEAR_CA NULL
#define OPTION_VAL_LINEAR_CA NULL
#define OPTION_VAL_STEREO_PANNING_CA NULL
#define QUICKNES_AUDIO_EQ_LABEL_CA NULL
#define QUICKNES_AUDIO_EQ_INFO_0_CA NULL
#define OPTION_VAL_FAMICOM_CA NULL
#define OPTION_VAL_TV_CA NULL
#define OPTION_VAL_FLAT_CA NULL
#define OPTION_VAL_CRISP_CA NULL
#define OPTION_VAL_TINNY_CA NULL
#define QUICKNES_TURBO_ENABLE_LABEL_CA NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_CA NULL
#define OPTION_VAL_NONE_CA "Cap"
#define OPTION_VAL_PLAYER_1_CA NULL
#define OPTION_VAL_PLAYER_2_CA NULL
#define OPTION_VAL_BOTH_CA NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_CA NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_CA NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_CA NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_CA NULL

struct retro_core_option_v2_category option_cats_ca[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_ca[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_CA,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_CA,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_CA },
         { "4:3", OPTION_VAL_4_3_CA },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_CA,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_CA,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_CA,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_CA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_CA,
      NULL,
      QUICKNES_PALETTE_INFO_0_CA,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_CA },
         { "asqrealc",             OPTION_VAL_ASQREALC_CA },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_CA },
         { "rgb",                  OPTION_VAL_RGB_CA },
         { "yuv-v3",               OPTION_VAL_YUV_V3_CA },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_CA },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_CA },
         { "pal",                  OPTION_VAL_PAL_CA },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_CA },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_CA },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_CA },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_CA },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_CA },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_CA },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_CA },
         { "nescap",               OPTION_VAL_NESCAP_CA },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_CA },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_CA,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_CA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_CA,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_CA,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_CA },
         { "linear",         OPTION_VAL_LINEAR_CA },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_CA },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_CA,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_CA,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_CA },
         { "famicom", OPTION_VAL_FAMICOM_CA },
         { "tv",      OPTION_VAL_TV_CA },
         { "flat",    OPTION_VAL_FLAT_CA },
         { "crisp",   OPTION_VAL_CRISP_CA },
         { "tinny",   OPTION_VAL_TINNY_CA },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_CA,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_CA,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_CA },
         { "player 1", OPTION_VAL_PLAYER_1_CA },
         { "player 2", OPTION_VAL_PLAYER_2_CA },
         { "both",     OPTION_VAL_BOTH_CA },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_CA,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_CA,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_CA,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_CA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_ca = {
   option_cats_ca,
   option_defs_ca
};

/* RETRO_LANGUAGE_CHS */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_CHS "纵横比"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_CHS NULL
#define OPTION_VAL_PAR_CHS NULL
#define OPTION_VAL_4_3_CHS NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_CHS NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_CHS NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_CHS NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_CHS NULL
#define QUICKNES_PALETTE_LABEL_CHS "色板"
#define QUICKNES_PALETTE_INFO_0_CHS NULL
#define OPTION_VAL_DEFAULT_CHS "默认值"
#define OPTION_VAL_ASQREALC_CHS NULL
#define OPTION_VAL_NINTENDO_VC_CHS NULL
#define OPTION_VAL_RGB_CHS NULL
#define OPTION_VAL_YUV_V3_CHS NULL
#define OPTION_VAL_UNSATURATED_FINAL_CHS NULL
#define OPTION_VAL_SONY_CXA2025AS_US_CHS NULL
#define OPTION_VAL_PAL_CHS NULL
#define OPTION_VAL_BMF_FINAL2_CHS NULL
#define OPTION_VAL_BMF_FINAL3_CHS NULL
#define OPTION_VAL_SMOOTH_FBX_CHS NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_CHS NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_CHS NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_CHS NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_CHS NULL
#define OPTION_VAL_NESCAP_CHS NULL
#define OPTION_VAL_WAVEBEAM_CHS NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_CHS NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_CHS NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_CHS NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_CHS NULL
#define OPTION_VAL_NONLINEAR_CHS NULL
#define OPTION_VAL_LINEAR_CHS "线性"
#define OPTION_VAL_STEREO_PANNING_CHS NULL
#define QUICKNES_AUDIO_EQ_LABEL_CHS NULL
#define QUICKNES_AUDIO_EQ_INFO_0_CHS NULL
#define OPTION_VAL_FAMICOM_CHS NULL
#define OPTION_VAL_TV_CHS NULL
#define OPTION_VAL_FLAT_CHS "扁平"
#define OPTION_VAL_CRISP_CHS "快速"
#define OPTION_VAL_TINNY_CHS NULL
#define QUICKNES_TURBO_ENABLE_LABEL_CHS NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_CHS NULL
#define OPTION_VAL_NONE_CHS "无"
#define OPTION_VAL_PLAYER_1_CHS "玩家甲"
#define OPTION_VAL_PLAYER_2_CHS "玩家乙"
#define OPTION_VAL_BOTH_CHS NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_CHS NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_CHS NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_CHS NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_CHS NULL

struct retro_core_option_v2_category option_cats_chs[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_chs[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_CHS,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_CHS,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_CHS },
         { "4:3", OPTION_VAL_4_3_CHS },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_CHS,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_CHS,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_CHS,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_CHS,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_CHS,
      NULL,
      QUICKNES_PALETTE_INFO_0_CHS,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_CHS },
         { "asqrealc",             OPTION_VAL_ASQREALC_CHS },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_CHS },
         { "rgb",                  OPTION_VAL_RGB_CHS },
         { "yuv-v3",               OPTION_VAL_YUV_V3_CHS },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_CHS },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_CHS },
         { "pal",                  OPTION_VAL_PAL_CHS },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_CHS },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_CHS },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_CHS },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_CHS },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_CHS },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_CHS },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_CHS },
         { "nescap",               OPTION_VAL_NESCAP_CHS },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_CHS },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_CHS,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_CHS,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_CHS,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_CHS,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_CHS },
         { "linear",         OPTION_VAL_LINEAR_CHS },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_CHS },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_CHS,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_CHS,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_CHS },
         { "famicom", OPTION_VAL_FAMICOM_CHS },
         { "tv",      OPTION_VAL_TV_CHS },
         { "flat",    OPTION_VAL_FLAT_CHS },
         { "crisp",   OPTION_VAL_CRISP_CHS },
         { "tinny",   OPTION_VAL_TINNY_CHS },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_CHS,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_CHS,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_CHS },
         { "player 1", OPTION_VAL_PLAYER_1_CHS },
         { "player 2", OPTION_VAL_PLAYER_2_CHS },
         { "both",     OPTION_VAL_BOTH_CHS },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_CHS,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_CHS,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_CHS,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_CHS,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_chs = {
   option_cats_chs,
   option_defs_chs
};

/* RETRO_LANGUAGE_CHT */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_CHT "寬高比"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_CHT NULL
#define OPTION_VAL_PAR_CHT "標準"
#define OPTION_VAL_4_3_CHT NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_CHT NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_CHT NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_CHT NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_CHT NULL
#define QUICKNES_PALETTE_LABEL_CHT "影像配色"
#define QUICKNES_PALETTE_INFO_0_CHT NULL
#define OPTION_VAL_DEFAULT_CHT "預設"
#define OPTION_VAL_ASQREALC_CHT NULL
#define OPTION_VAL_NINTENDO_VC_CHT NULL
#define OPTION_VAL_RGB_CHT NULL
#define OPTION_VAL_YUV_V3_CHT NULL
#define OPTION_VAL_UNSATURATED_FINAL_CHT NULL
#define OPTION_VAL_SONY_CXA2025AS_US_CHT NULL
#define OPTION_VAL_PAL_CHT NULL
#define OPTION_VAL_BMF_FINAL2_CHT NULL
#define OPTION_VAL_BMF_FINAL3_CHT NULL
#define OPTION_VAL_SMOOTH_FBX_CHT NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_CHT NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_CHT NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_CHT NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_CHT NULL
#define OPTION_VAL_NESCAP_CHT NULL
#define OPTION_VAL_WAVEBEAM_CHT NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_CHT "沒有素材限制"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_CHT NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_CHT NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_CHT NULL
#define OPTION_VAL_NONLINEAR_CHT NULL
#define OPTION_VAL_LINEAR_CHT "線性"
#define OPTION_VAL_STEREO_PANNING_CHT NULL
#define QUICKNES_AUDIO_EQ_LABEL_CHT "預設音頻均衡器"
#define QUICKNES_AUDIO_EQ_INFO_0_CHT NULL
#define OPTION_VAL_FAMICOM_CHT "紅白機"
#define OPTION_VAL_TV_CHT "電視"
#define OPTION_VAL_FLAT_CHT "單調"
#define OPTION_VAL_CRISP_CHT "清脆"
#define OPTION_VAL_TINNY_CHT NULL
#define QUICKNES_TURBO_ENABLE_LABEL_CHT NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_CHT NULL
#define OPTION_VAL_NONE_CHT "無"
#define OPTION_VAL_PLAYER_1_CHT "玩家 1"
#define OPTION_VAL_PLAYER_2_CHT "玩家 2"
#define OPTION_VAL_BOTH_CHT "玩家 1 與 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_CHT NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_CHT NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_CHT "允許反向操作"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_CHT "允許反方向快速操作，可同時按下左右或上下的方向。可能導致遊戲的移動架構出錯。"

struct retro_core_option_v2_category option_cats_cht[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_cht[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_CHT,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_CHT,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_CHT },
         { "4:3", OPTION_VAL_4_3_CHT },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_CHT,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_CHT,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_CHT,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_CHT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_CHT,
      NULL,
      QUICKNES_PALETTE_INFO_0_CHT,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_CHT },
         { "asqrealc",             OPTION_VAL_ASQREALC_CHT },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_CHT },
         { "rgb",                  OPTION_VAL_RGB_CHT },
         { "yuv-v3",               OPTION_VAL_YUV_V3_CHT },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_CHT },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_CHT },
         { "pal",                  OPTION_VAL_PAL_CHT },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_CHT },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_CHT },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_CHT },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_CHT },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_CHT },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_CHT },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_CHT },
         { "nescap",               OPTION_VAL_NESCAP_CHT },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_CHT },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_CHT,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_CHT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_CHT,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_CHT,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_CHT },
         { "linear",         OPTION_VAL_LINEAR_CHT },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_CHT },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_CHT,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_CHT,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_CHT },
         { "famicom", OPTION_VAL_FAMICOM_CHT },
         { "tv",      OPTION_VAL_TV_CHT },
         { "flat",    OPTION_VAL_FLAT_CHT },
         { "crisp",   OPTION_VAL_CRISP_CHT },
         { "tinny",   OPTION_VAL_TINNY_CHT },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_CHT,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_CHT,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_CHT },
         { "player 1", OPTION_VAL_PLAYER_1_CHT },
         { "player 2", OPTION_VAL_PLAYER_2_CHT },
         { "both",     OPTION_VAL_BOTH_CHT },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_CHT,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_CHT,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_CHT,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_CHT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_cht = {
   option_cats_cht,
   option_defs_cht
};

/* RETRO_LANGUAGE_CS */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_CS "Poměr Stran"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_CS "To platí pouze v případě, že je poměr stran aplikace RetroArch v nastavení videa nastaven na hodnotu 'Poskytnuté Jádro'."
#define OPTION_VAL_PAR_CS NULL
#define OPTION_VAL_4_3_CS NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_CS "Zobrazit Horizontální Overscan"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_CS "Zakázáním této funkce oříznete (vodorovně) potenciálně náhodný poruchový obrazový výstup, který by byl skrytý za rámečkem kolem okraje obrazovky televizoru se standardním rozlišením."
#define QUICKNES_USE_OVERSCAN_V_LABEL_CS "Zobrazit Vertikální Overscan"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_CS "Zakázáním této funkce oříznete (na výšku) potenciálně náhodný poruchový obrazový výstup, který by byl skrytý za rámečkem kolem okraje obrazovky televizoru se standardním rozlišením."
#define QUICKNES_PALETTE_LABEL_CS "Paleta Barev"
#define QUICKNES_PALETTE_INFO_0_CS "Určuje, která barevná paleta se má použít při dekódování videosignálu NTSC na výstupu ze sítě NES."
#define OPTION_VAL_DEFAULT_CS "Výchozí"
#define OPTION_VAL_ASQREALC_CS NULL
#define OPTION_VAL_NINTENDO_VC_CS NULL
#define OPTION_VAL_RGB_CS NULL
#define OPTION_VAL_YUV_V3_CS NULL
#define OPTION_VAL_UNSATURATED_FINAL_CS NULL
#define OPTION_VAL_SONY_CXA2025AS_US_CS NULL
#define OPTION_VAL_PAL_CS NULL
#define OPTION_VAL_BMF_FINAL2_CS NULL
#define OPTION_VAL_BMF_FINAL3_CS NULL
#define OPTION_VAL_SMOOTH_FBX_CS NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_CS NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_CS NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_CS NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_CS NULL
#define OPTION_VAL_NESCAP_CS NULL
#define OPTION_VAL_WAVEBEAM_CS NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_CS "Žádný Limit Spritu"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_CS "Odstraní hardwarový limit 8 bodů na řádek. To snižuje blikání, ale může způsobovat vizuální závady, protože některé hry využívají hardwarový limit ke generování speciálních efektů."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_CS "Zvukový Režim"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_CS "Konfigurace emulace zvuku. 'Nelineární' simuluje nelineární míchání kanálů NES APU. 'Lineární' používá méně přesnou aproximaci, která snižuje kvalitu, ale zvyšuje výkon na low-endovém hardwaru. 'Stereo Panorama' přidává monofonnímu výstupu NES hloubku pomocí technik panorámování a efektů dozvuku."
#define OPTION_VAL_NONLINEAR_CS "Nelineární"
#define OPTION_VAL_LINEAR_CS NULL
#define OPTION_VAL_STEREO_PANNING_CS "Stereo Panorama"
#define QUICKNES_AUDIO_EQ_LABEL_CS "Předvolva Zvukového Ekvalizéru"
#define QUICKNES_AUDIO_EQ_INFO_0_CS "Upravte rovnováhu mezi frekvenčními složkami zvuku pomocí vlastní předvolby ekvalizéru."
#define OPTION_VAL_FAMICOM_CS NULL
#define OPTION_VAL_TV_CS NULL
#define OPTION_VAL_FLAT_CS "Ploché"
#define OPTION_VAL_CRISP_CS "Křupavé"
#define OPTION_VAL_TINNY_CS "Metalická"
#define QUICKNES_TURBO_ENABLE_LABEL_CS "Povolení Turba"
#define QUICKNES_TURBO_ENABLE_INFO_0_CS "Umožňuje použití tlačítek Turbo A a Turbo B."
#define OPTION_VAL_NONE_CS "Žádné"
#define OPTION_VAL_PLAYER_1_CS "Hráč 1"
#define OPTION_VAL_PLAYER_2_CS "Hráč 2"
#define OPTION_VAL_BOTH_CS "Hráč 1 a 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_CS "Šířka Turboimpulzu (ve snímcích)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_CS "Určuje šířku i rozestup (ve snímcích) vstupních \"pulzů\" při stisknutých tlačítkách Turbo A a Turbo B. Například výchozí nastavení \"3\" odpovídá frekvenci (60/(3+3)) = 10 Hz turbo (10 stisknutí za sekundu)."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_CS "Povolit Opačné Směry"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_CS "Povolení této funkce umožní stisknout / rychle střídat / držet současně levý i pravý směr (nebo nahoru a dolů). To může způsobit závady založené na pohybu."

struct retro_core_option_v2_category option_cats_cs[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_cs[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_CS,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_CS,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_CS },
         { "4:3", OPTION_VAL_4_3_CS },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_CS,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_CS,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_CS,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_CS,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_CS,
      NULL,
      QUICKNES_PALETTE_INFO_0_CS,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_CS },
         { "asqrealc",             OPTION_VAL_ASQREALC_CS },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_CS },
         { "rgb",                  OPTION_VAL_RGB_CS },
         { "yuv-v3",               OPTION_VAL_YUV_V3_CS },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_CS },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_CS },
         { "pal",                  OPTION_VAL_PAL_CS },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_CS },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_CS },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_CS },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_CS },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_CS },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_CS },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_CS },
         { "nescap",               OPTION_VAL_NESCAP_CS },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_CS },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_CS,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_CS,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_CS,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_CS,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_CS },
         { "linear",         OPTION_VAL_LINEAR_CS },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_CS },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_CS,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_CS,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_CS },
         { "famicom", OPTION_VAL_FAMICOM_CS },
         { "tv",      OPTION_VAL_TV_CS },
         { "flat",    OPTION_VAL_FLAT_CS },
         { "crisp",   OPTION_VAL_CRISP_CS },
         { "tinny",   OPTION_VAL_TINNY_CS },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_CS,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_CS,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_CS },
         { "player 1", OPTION_VAL_PLAYER_1_CS },
         { "player 2", OPTION_VAL_PLAYER_2_CS },
         { "both",     OPTION_VAL_BOTH_CS },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_CS,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_CS,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_CS,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_CS,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_cs = {
   option_cats_cs,
   option_defs_cs
};

/* RETRO_LANGUAGE_CY */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_CY NULL
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_CY NULL
#define OPTION_VAL_PAR_CY NULL
#define OPTION_VAL_4_3_CY NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_CY NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_CY NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_CY NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_CY NULL
#define QUICKNES_PALETTE_LABEL_CY NULL
#define QUICKNES_PALETTE_INFO_0_CY NULL
#define OPTION_VAL_DEFAULT_CY NULL
#define OPTION_VAL_ASQREALC_CY NULL
#define OPTION_VAL_NINTENDO_VC_CY NULL
#define OPTION_VAL_RGB_CY NULL
#define OPTION_VAL_YUV_V3_CY NULL
#define OPTION_VAL_UNSATURATED_FINAL_CY NULL
#define OPTION_VAL_SONY_CXA2025AS_US_CY NULL
#define OPTION_VAL_PAL_CY NULL
#define OPTION_VAL_BMF_FINAL2_CY NULL
#define OPTION_VAL_BMF_FINAL3_CY NULL
#define OPTION_VAL_SMOOTH_FBX_CY NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_CY NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_CY NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_CY NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_CY NULL
#define OPTION_VAL_NESCAP_CY NULL
#define OPTION_VAL_WAVEBEAM_CY NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_CY NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_CY NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_CY NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_CY NULL
#define OPTION_VAL_NONLINEAR_CY NULL
#define OPTION_VAL_LINEAR_CY NULL
#define OPTION_VAL_STEREO_PANNING_CY NULL
#define QUICKNES_AUDIO_EQ_LABEL_CY NULL
#define QUICKNES_AUDIO_EQ_INFO_0_CY NULL
#define OPTION_VAL_FAMICOM_CY NULL
#define OPTION_VAL_TV_CY NULL
#define OPTION_VAL_FLAT_CY NULL
#define OPTION_VAL_CRISP_CY NULL
#define OPTION_VAL_TINNY_CY NULL
#define QUICKNES_TURBO_ENABLE_LABEL_CY NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_CY NULL
#define OPTION_VAL_NONE_CY "Dim"
#define OPTION_VAL_PLAYER_1_CY NULL
#define OPTION_VAL_PLAYER_2_CY NULL
#define OPTION_VAL_BOTH_CY NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_CY NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_CY NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_CY NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_CY NULL

struct retro_core_option_v2_category option_cats_cy[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_cy[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_CY,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_CY,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_CY },
         { "4:3", OPTION_VAL_4_3_CY },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_CY,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_CY,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_CY,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_CY,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_CY,
      NULL,
      QUICKNES_PALETTE_INFO_0_CY,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_CY },
         { "asqrealc",             OPTION_VAL_ASQREALC_CY },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_CY },
         { "rgb",                  OPTION_VAL_RGB_CY },
         { "yuv-v3",               OPTION_VAL_YUV_V3_CY },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_CY },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_CY },
         { "pal",                  OPTION_VAL_PAL_CY },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_CY },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_CY },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_CY },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_CY },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_CY },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_CY },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_CY },
         { "nescap",               OPTION_VAL_NESCAP_CY },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_CY },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_CY,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_CY,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_CY,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_CY,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_CY },
         { "linear",         OPTION_VAL_LINEAR_CY },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_CY },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_CY,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_CY,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_CY },
         { "famicom", OPTION_VAL_FAMICOM_CY },
         { "tv",      OPTION_VAL_TV_CY },
         { "flat",    OPTION_VAL_FLAT_CY },
         { "crisp",   OPTION_VAL_CRISP_CY },
         { "tinny",   OPTION_VAL_TINNY_CY },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_CY,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_CY,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_CY },
         { "player 1", OPTION_VAL_PLAYER_1_CY },
         { "player 2", OPTION_VAL_PLAYER_2_CY },
         { "both",     OPTION_VAL_BOTH_CY },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_CY,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_CY,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_CY,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_CY,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_cy = {
   option_cats_cy,
   option_defs_cy
};

/* RETRO_LANGUAGE_DA */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_DA NULL
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_DA NULL
#define OPTION_VAL_PAR_DA NULL
#define OPTION_VAL_4_3_DA NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_DA NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_DA NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_DA NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_DA NULL
#define QUICKNES_PALETTE_LABEL_DA NULL
#define QUICKNES_PALETTE_INFO_0_DA NULL
#define OPTION_VAL_DEFAULT_DA NULL
#define OPTION_VAL_ASQREALC_DA NULL
#define OPTION_VAL_NINTENDO_VC_DA NULL
#define OPTION_VAL_RGB_DA NULL
#define OPTION_VAL_YUV_V3_DA NULL
#define OPTION_VAL_UNSATURATED_FINAL_DA NULL
#define OPTION_VAL_SONY_CXA2025AS_US_DA NULL
#define OPTION_VAL_PAL_DA NULL
#define OPTION_VAL_BMF_FINAL2_DA NULL
#define OPTION_VAL_BMF_FINAL3_DA NULL
#define OPTION_VAL_SMOOTH_FBX_DA NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_DA NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_DA NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_DA NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_DA NULL
#define OPTION_VAL_NESCAP_DA NULL
#define OPTION_VAL_WAVEBEAM_DA NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_DA NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_DA NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_DA NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_DA NULL
#define OPTION_VAL_NONLINEAR_DA NULL
#define OPTION_VAL_LINEAR_DA NULL
#define OPTION_VAL_STEREO_PANNING_DA NULL
#define QUICKNES_AUDIO_EQ_LABEL_DA NULL
#define QUICKNES_AUDIO_EQ_INFO_0_DA NULL
#define OPTION_VAL_FAMICOM_DA NULL
#define OPTION_VAL_TV_DA NULL
#define OPTION_VAL_FLAT_DA NULL
#define OPTION_VAL_CRISP_DA NULL
#define OPTION_VAL_TINNY_DA NULL
#define QUICKNES_TURBO_ENABLE_LABEL_DA NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_DA NULL
#define OPTION_VAL_NONE_DA NULL
#define OPTION_VAL_PLAYER_1_DA NULL
#define OPTION_VAL_PLAYER_2_DA NULL
#define OPTION_VAL_BOTH_DA NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_DA NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_DA NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_DA NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_DA NULL

struct retro_core_option_v2_category option_cats_da[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_da[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_DA,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_DA,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_DA },
         { "4:3", OPTION_VAL_4_3_DA },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_DA,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_DA,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_DA,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_DA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_DA,
      NULL,
      QUICKNES_PALETTE_INFO_0_DA,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_DA },
         { "asqrealc",             OPTION_VAL_ASQREALC_DA },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_DA },
         { "rgb",                  OPTION_VAL_RGB_DA },
         { "yuv-v3",               OPTION_VAL_YUV_V3_DA },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_DA },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_DA },
         { "pal",                  OPTION_VAL_PAL_DA },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_DA },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_DA },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_DA },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_DA },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_DA },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_DA },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_DA },
         { "nescap",               OPTION_VAL_NESCAP_DA },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_DA },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_DA,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_DA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_DA,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_DA,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_DA },
         { "linear",         OPTION_VAL_LINEAR_DA },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_DA },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_DA,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_DA,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_DA },
         { "famicom", OPTION_VAL_FAMICOM_DA },
         { "tv",      OPTION_VAL_TV_DA },
         { "flat",    OPTION_VAL_FLAT_DA },
         { "crisp",   OPTION_VAL_CRISP_DA },
         { "tinny",   OPTION_VAL_TINNY_DA },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_DA,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_DA,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_DA },
         { "player 1", OPTION_VAL_PLAYER_1_DA },
         { "player 2", OPTION_VAL_PLAYER_2_DA },
         { "both",     OPTION_VAL_BOTH_DA },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_DA,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_DA,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_DA,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_DA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_da = {
   option_cats_da,
   option_defs_da
};

/* RETRO_LANGUAGE_DE */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_DE "Bildseitenverhältnis"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_DE "Dies gilt nur, wenn das Seitenverhältnis von RetroArch in den Videoeinstellungen auf „Core-bestimmt“ eingestellt ist."
#define OPTION_VAL_PAR_DE NULL
#define OPTION_VAL_4_3_DE NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_DE "Horizontalen Overscan anzeigen"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_DE "Dies deaktivieren, um die (horizontal) potenziell zufällig auftretende, fehlerhafte Videoausgabe auszublenden, die durch den Rand eines Fernsehbildschirms mit Standardauflösung verdeckt wäre."
#define QUICKNES_USE_OVERSCAN_V_LABEL_DE "Vertikalen Overscan anzeigen"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_DE "Dies deaktivieren, um die (vertikal) potenziell zufällig auftretende, fehlerhafte Videoausgabe auszublenden, die durch den Rand eines Fernsehbildschirms mit Standardauflösung verdeckt wäre."
#define QUICKNES_PALETTE_LABEL_DE "Farbpalette"
#define QUICKNES_PALETTE_INFO_0_DE "Gibt an, welche Farbpalette bei der Dekodierung des vom NES ausgegebenen NTSC-Videosignals verwendet werden soll."
#define OPTION_VAL_DEFAULT_DE "Standard"
#define OPTION_VAL_ASQREALC_DE NULL
#define OPTION_VAL_NINTENDO_VC_DE "Nintendo Virtuelle Konsole"
#define OPTION_VAL_RGB_DE NULL
#define OPTION_VAL_YUV_V3_DE "FBXs YUV-V3"
#define OPTION_VAL_UNSATURATED_FINAL_DE "FBX's Ungesättigt-Final"
#define OPTION_VAL_SONY_CXA2025AS_US_DE NULL
#define OPTION_VAL_PAL_DE NULL
#define OPTION_VAL_BMF_FINAL2_DE "BMFs Final 2"
#define OPTION_VAL_BMF_FINAL3_DE "BMFs Final 3"
#define OPTION_VAL_SMOOTH_FBX_DE "FBXs Glatt"
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_DE "FBXs Composite Direct"
#define OPTION_VAL_PVM_STYLE_D93_FBX_DE "FBXs PVM-Stil D93"
#define OPTION_VAL_NTSC_HARDWARE_FBX_DE "FBXs NTSC-Hardware"
#define OPTION_VAL_NES_CLASSIC_FBX_FS_DE "FBXs NES-Classic (fest)"
#define OPTION_VAL_NESCAP_DE NULL
#define OPTION_VAL_WAVEBEAM_DE "nakedarthur's Wellenstrahl"
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_DE "Kein Sprite-Limit"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_DE "Entfernt die Hardwarebeschränkung von 8 Sprites pro Scanline. Dies reduziert Flickring, kann aber zu visuellen Fehlern führen, da einige Spiele das Hardware-Limit nutzen, um spezielle Effekte zu erzeugen."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_DE "Audiomodus"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_DE "Die Audio-Emulation konfigurieren. „Nicht-linear“ simuliert die nicht-lineare Kanalmischung der NES APU. „Linear“ verwendet eine weniger genaue Annäherung, die die Qualität mindert, aber die Leistung auf leistungsschwacher Hardware erhöht. „Stereo-Panorama“ verleiht dem NES-Mono-Ausgang durch die Verwendung von Panning-Techniken und Halleffekten mehr Tiefe."
#define OPTION_VAL_NONLINEAR_DE "Nicht-linear"
#define OPTION_VAL_LINEAR_DE NULL
#define OPTION_VAL_STEREO_PANNING_DE "Stereo-Panorama"
#define QUICKNES_AUDIO_EQ_LABEL_DE "Audioequalizer-Voreinstellung"
#define QUICKNES_AUDIO_EQ_INFO_0_DE "Die Balance zwischen Audiofrequenzkomponenten mit einer benutzerdefinierten Equalizer-Voreinstellung anpassen."
#define OPTION_VAL_FAMICOM_DE NULL
#define OPTION_VAL_TV_DE NULL
#define OPTION_VAL_FLAT_DE "Flach"
#define OPTION_VAL_CRISP_DE "Knackig"
#define OPTION_VAL_TINNY_DE "Blechern"
#define QUICKNES_TURBO_ENABLE_LABEL_DE "Turbo aktivieren"
#define QUICKNES_TURBO_ENABLE_INFO_0_DE "Aktiviert die Verwendung der Tasten Turbo A und Turbo B."
#define OPTION_VAL_NONE_DE "Keine"
#define OPTION_VAL_PLAYER_1_DE "Spieler 1"
#define OPTION_VAL_PLAYER_2_DE "Spieler 2"
#define OPTION_VAL_BOTH_DE "Spieler 1 und 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_DE "Turbo-Pulsbreite (in Frames)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_DE "Gibt sowohl die Breite als auch den Abstand (in Frames) der Eingabe-„Impulse“ an, wenn die Tasten Turbo A und Turbo B gedrückt gehalten werden. Die Standardeinstellung „3“ entspricht beispielsweise einer Turbofrequenz von (60/(3+3)) = 10 Hz (10 Betätigungen pro Sekunde)."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_DE "Entgegengesetzte Richtungen zulassen"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_DE "Wenn diese Funktion aktiviert ist, kann gleichzeitig die linke und die rechte (oder die obere und die untere) Richtungstaste bzw. schnell abwechselnd gedrückt oder gehalten werden. Dies kann zu bewegungsbasierten Fehlern führen."

struct retro_core_option_v2_category option_cats_de[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_de[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_DE,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_DE,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_DE },
         { "4:3", OPTION_VAL_4_3_DE },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_DE,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_DE,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_DE,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_DE,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_DE,
      NULL,
      QUICKNES_PALETTE_INFO_0_DE,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_DE },
         { "asqrealc",             OPTION_VAL_ASQREALC_DE },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_DE },
         { "rgb",                  OPTION_VAL_RGB_DE },
         { "yuv-v3",               OPTION_VAL_YUV_V3_DE },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_DE },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_DE },
         { "pal",                  OPTION_VAL_PAL_DE },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_DE },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_DE },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_DE },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_DE },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_DE },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_DE },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_DE },
         { "nescap",               OPTION_VAL_NESCAP_DE },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_DE },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_DE,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_DE,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_DE,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_DE,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_DE },
         { "linear",         OPTION_VAL_LINEAR_DE },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_DE },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_DE,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_DE,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_DE },
         { "famicom", OPTION_VAL_FAMICOM_DE },
         { "tv",      OPTION_VAL_TV_DE },
         { "flat",    OPTION_VAL_FLAT_DE },
         { "crisp",   OPTION_VAL_CRISP_DE },
         { "tinny",   OPTION_VAL_TINNY_DE },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_DE,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_DE,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_DE },
         { "player 1", OPTION_VAL_PLAYER_1_DE },
         { "player 2", OPTION_VAL_PLAYER_2_DE },
         { "both",     OPTION_VAL_BOTH_DE },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_DE,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_DE,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_DE,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_DE,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_de = {
   option_cats_de,
   option_defs_de
};

/* RETRO_LANGUAGE_EL */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_EL "Αναλογία Οθόνης"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_EL NULL
#define OPTION_VAL_PAR_EL NULL
#define OPTION_VAL_4_3_EL NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_EL NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_EL NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_EL NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_EL NULL
#define QUICKNES_PALETTE_LABEL_EL "Παλέτα Χρωμάτων"
#define QUICKNES_PALETTE_INFO_0_EL NULL
#define OPTION_VAL_DEFAULT_EL "Προκαθορισμένο"
#define OPTION_VAL_ASQREALC_EL NULL
#define OPTION_VAL_NINTENDO_VC_EL NULL
#define OPTION_VAL_RGB_EL NULL
#define OPTION_VAL_YUV_V3_EL NULL
#define OPTION_VAL_UNSATURATED_FINAL_EL NULL
#define OPTION_VAL_SONY_CXA2025AS_US_EL NULL
#define OPTION_VAL_PAL_EL NULL
#define OPTION_VAL_BMF_FINAL2_EL NULL
#define OPTION_VAL_BMF_FINAL3_EL NULL
#define OPTION_VAL_SMOOTH_FBX_EL NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_EL NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_EL NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_EL NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_EL NULL
#define OPTION_VAL_NESCAP_EL NULL
#define OPTION_VAL_WAVEBEAM_EL NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_EL NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_EL NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_EL NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_EL NULL
#define OPTION_VAL_NONLINEAR_EL NULL
#define OPTION_VAL_LINEAR_EL "Γραμμικό"
#define OPTION_VAL_STEREO_PANNING_EL NULL
#define QUICKNES_AUDIO_EQ_LABEL_EL NULL
#define QUICKNES_AUDIO_EQ_INFO_0_EL NULL
#define OPTION_VAL_FAMICOM_EL NULL
#define OPTION_VAL_TV_EL "Τηλεόραση"
#define OPTION_VAL_FLAT_EL NULL
#define OPTION_VAL_CRISP_EL NULL
#define OPTION_VAL_TINNY_EL NULL
#define QUICKNES_TURBO_ENABLE_LABEL_EL "Ενεργοποίηση Turbo"
#define QUICKNES_TURBO_ENABLE_INFO_0_EL NULL
#define OPTION_VAL_NONE_EL "Τίποτα"
#define OPTION_VAL_PLAYER_1_EL "Παίκτης 1"
#define OPTION_VAL_PLAYER_2_EL "Παίκτης 2"
#define OPTION_VAL_BOTH_EL "Παίκτης 1 & 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_EL NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_EL NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_EL NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_EL NULL

struct retro_core_option_v2_category option_cats_el[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_el[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_EL,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_EL,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_EL },
         { "4:3", OPTION_VAL_4_3_EL },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_EL,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_EL,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_EL,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_EL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_EL,
      NULL,
      QUICKNES_PALETTE_INFO_0_EL,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_EL },
         { "asqrealc",             OPTION_VAL_ASQREALC_EL },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_EL },
         { "rgb",                  OPTION_VAL_RGB_EL },
         { "yuv-v3",               OPTION_VAL_YUV_V3_EL },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_EL },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_EL },
         { "pal",                  OPTION_VAL_PAL_EL },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_EL },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_EL },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_EL },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_EL },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_EL },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_EL },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_EL },
         { "nescap",               OPTION_VAL_NESCAP_EL },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_EL },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_EL,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_EL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_EL,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_EL,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_EL },
         { "linear",         OPTION_VAL_LINEAR_EL },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_EL },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_EL,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_EL,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_EL },
         { "famicom", OPTION_VAL_FAMICOM_EL },
         { "tv",      OPTION_VAL_TV_EL },
         { "flat",    OPTION_VAL_FLAT_EL },
         { "crisp",   OPTION_VAL_CRISP_EL },
         { "tinny",   OPTION_VAL_TINNY_EL },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_EL,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_EL,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_EL },
         { "player 1", OPTION_VAL_PLAYER_1_EL },
         { "player 2", OPTION_VAL_PLAYER_2_EL },
         { "both",     OPTION_VAL_BOTH_EL },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_EL,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_EL,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_EL,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_EL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_el = {
   option_cats_el,
   option_defs_el
};

/* RETRO_LANGUAGE_EN */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_EN NULL
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_EN NULL
#define OPTION_VAL_PAR_EN NULL
#define OPTION_VAL_4_3_EN NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_EN NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_EN NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_EN NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_EN NULL
#define QUICKNES_PALETTE_LABEL_EN "Colour Palette"
#define QUICKNES_PALETTE_INFO_0_EN "Specifies which colour palette to use when decoding the NTSC video signal output by the NES."
#define OPTION_VAL_DEFAULT_EN NULL
#define OPTION_VAL_ASQREALC_EN NULL
#define OPTION_VAL_NINTENDO_VC_EN NULL
#define OPTION_VAL_RGB_EN NULL
#define OPTION_VAL_YUV_V3_EN NULL
#define OPTION_VAL_UNSATURATED_FINAL_EN NULL
#define OPTION_VAL_SONY_CXA2025AS_US_EN NULL
#define OPTION_VAL_PAL_EN NULL
#define OPTION_VAL_BMF_FINAL2_EN NULL
#define OPTION_VAL_BMF_FINAL3_EN NULL
#define OPTION_VAL_SMOOTH_FBX_EN NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_EN NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_EN NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_EN NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_EN NULL
#define OPTION_VAL_NESCAP_EN NULL
#define OPTION_VAL_WAVEBEAM_EN NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_EN NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_EN "Removes the 8-sprite-per-scan-line hardware limit. This reduces flickering but can cause visual glitches, as some games exploit the hardware limit to generate special effects."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_EN NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_EN NULL
#define OPTION_VAL_NONLINEAR_EN NULL
#define OPTION_VAL_LINEAR_EN NULL
#define OPTION_VAL_STEREO_PANNING_EN NULL
#define QUICKNES_AUDIO_EQ_LABEL_EN "Audio Equaliser Preset"
#define QUICKNES_AUDIO_EQ_INFO_0_EN "Adjust the balance between audio frequency components with a custom equaliser preset."
#define OPTION_VAL_FAMICOM_EN NULL
#define OPTION_VAL_TV_EN NULL
#define OPTION_VAL_FLAT_EN NULL
#define OPTION_VAL_CRISP_EN NULL
#define OPTION_VAL_TINNY_EN NULL
#define QUICKNES_TURBO_ENABLE_LABEL_EN NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_EN NULL
#define OPTION_VAL_NONE_EN NULL
#define OPTION_VAL_PLAYER_1_EN NULL
#define OPTION_VAL_PLAYER_2_EN NULL
#define OPTION_VAL_BOTH_EN NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_EN NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_EN NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_EN NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_EN NULL

struct retro_core_option_v2_category option_cats_en[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_en[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_EN,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_EN,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_EN },
         { "4:3", OPTION_VAL_4_3_EN },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_EN,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_EN,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_EN,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_EN,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_EN,
      NULL,
      QUICKNES_PALETTE_INFO_0_EN,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_EN },
         { "asqrealc",             OPTION_VAL_ASQREALC_EN },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_EN },
         { "rgb",                  OPTION_VAL_RGB_EN },
         { "yuv-v3",               OPTION_VAL_YUV_V3_EN },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_EN },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_EN },
         { "pal",                  OPTION_VAL_PAL_EN },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_EN },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_EN },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_EN },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_EN },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_EN },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_EN },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_EN },
         { "nescap",               OPTION_VAL_NESCAP_EN },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_EN },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_EN,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_EN,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_EN,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_EN,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_EN },
         { "linear",         OPTION_VAL_LINEAR_EN },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_EN },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_EN,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_EN,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_EN },
         { "famicom", OPTION_VAL_FAMICOM_EN },
         { "tv",      OPTION_VAL_TV_EN },
         { "flat",    OPTION_VAL_FLAT_EN },
         { "crisp",   OPTION_VAL_CRISP_EN },
         { "tinny",   OPTION_VAL_TINNY_EN },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_EN,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_EN,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_EN },
         { "player 1", OPTION_VAL_PLAYER_1_EN },
         { "player 2", OPTION_VAL_PLAYER_2_EN },
         { "both",     OPTION_VAL_BOTH_EN },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_EN,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_EN,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_EN,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_EN,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_en = {
   option_cats_en,
   option_defs_en
};

/* RETRO_LANGUAGE_EO */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_EO NULL
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_EO NULL
#define OPTION_VAL_PAR_EO NULL
#define OPTION_VAL_4_3_EO NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_EO NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_EO NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_EO NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_EO NULL
#define QUICKNES_PALETTE_LABEL_EO NULL
#define QUICKNES_PALETTE_INFO_0_EO NULL
#define OPTION_VAL_DEFAULT_EO NULL
#define OPTION_VAL_ASQREALC_EO NULL
#define OPTION_VAL_NINTENDO_VC_EO NULL
#define OPTION_VAL_RGB_EO NULL
#define OPTION_VAL_YUV_V3_EO NULL
#define OPTION_VAL_UNSATURATED_FINAL_EO NULL
#define OPTION_VAL_SONY_CXA2025AS_US_EO NULL
#define OPTION_VAL_PAL_EO NULL
#define OPTION_VAL_BMF_FINAL2_EO NULL
#define OPTION_VAL_BMF_FINAL3_EO NULL
#define OPTION_VAL_SMOOTH_FBX_EO NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_EO NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_EO NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_EO NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_EO NULL
#define OPTION_VAL_NESCAP_EO NULL
#define OPTION_VAL_WAVEBEAM_EO NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_EO NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_EO NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_EO NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_EO NULL
#define OPTION_VAL_NONLINEAR_EO NULL
#define OPTION_VAL_LINEAR_EO NULL
#define OPTION_VAL_STEREO_PANNING_EO NULL
#define QUICKNES_AUDIO_EQ_LABEL_EO NULL
#define QUICKNES_AUDIO_EQ_INFO_0_EO NULL
#define OPTION_VAL_FAMICOM_EO NULL
#define OPTION_VAL_TV_EO NULL
#define OPTION_VAL_FLAT_EO NULL
#define OPTION_VAL_CRISP_EO NULL
#define OPTION_VAL_TINNY_EO NULL
#define QUICKNES_TURBO_ENABLE_LABEL_EO NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_EO NULL
#define OPTION_VAL_NONE_EO NULL
#define OPTION_VAL_PLAYER_1_EO NULL
#define OPTION_VAL_PLAYER_2_EO NULL
#define OPTION_VAL_BOTH_EO NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_EO NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_EO NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_EO NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_EO NULL

struct retro_core_option_v2_category option_cats_eo[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_eo[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_EO,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_EO,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_EO },
         { "4:3", OPTION_VAL_4_3_EO },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_EO,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_EO,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_EO,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_EO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_EO,
      NULL,
      QUICKNES_PALETTE_INFO_0_EO,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_EO },
         { "asqrealc",             OPTION_VAL_ASQREALC_EO },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_EO },
         { "rgb",                  OPTION_VAL_RGB_EO },
         { "yuv-v3",               OPTION_VAL_YUV_V3_EO },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_EO },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_EO },
         { "pal",                  OPTION_VAL_PAL_EO },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_EO },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_EO },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_EO },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_EO },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_EO },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_EO },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_EO },
         { "nescap",               OPTION_VAL_NESCAP_EO },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_EO },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_EO,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_EO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_EO,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_EO,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_EO },
         { "linear",         OPTION_VAL_LINEAR_EO },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_EO },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_EO,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_EO,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_EO },
         { "famicom", OPTION_VAL_FAMICOM_EO },
         { "tv",      OPTION_VAL_TV_EO },
         { "flat",    OPTION_VAL_FLAT_EO },
         { "crisp",   OPTION_VAL_CRISP_EO },
         { "tinny",   OPTION_VAL_TINNY_EO },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_EO,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_EO,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_EO },
         { "player 1", OPTION_VAL_PLAYER_1_EO },
         { "player 2", OPTION_VAL_PLAYER_2_EO },
         { "both",     OPTION_VAL_BOTH_EO },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_EO,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_EO,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_EO,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_EO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_eo = {
   option_cats_eo,
   option_defs_eo
};

/* RETRO_LANGUAGE_ES */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_ES "Relación de aspecto"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_ES "Este ajuste solo surtirá efecto cuando la relación de aspecto de RetroArch esté configurada como «Indicada por el núcleo» (dentro de los ajustes de vídeo)."
#define OPTION_VAL_PAR_ES "PAR (relación de aspecto de píxeles)"
#define OPTION_VAL_4_3_ES NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_ES "Mostrar sobrebarrido horizontal"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_ES "Desactiva esta opción para recortar (la parte horizontal de) los posibles defectos visuales aleatorios de vídeo que normalmente ocultaría el marco de un televisor de definición estándar."
#define QUICKNES_USE_OVERSCAN_V_LABEL_ES "Mostrar sobrebarrido vertical"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_ES "Desactiva esta opción para recortar (la parte vertical de) los posibles defectos visuales aleatorios de vídeo que normalmente ocultaría el marco de un televisor de definición estándar."
#define QUICKNES_PALETTE_LABEL_ES "Paleta de colores"
#define QUICKNES_PALETTE_INFO_0_ES "Establece la paleta de colores que se utilizará al descodificar la salida de vídeo NTSC usada por la NES."
#define OPTION_VAL_DEFAULT_ES "Valor predeterminado"
#define OPTION_VAL_ASQREALC_ES "Real de AspiringSquire"
#define OPTION_VAL_NINTENDO_VC_ES "Consola virtual de Nintendo"
#define OPTION_VAL_RGB_ES "PPU RGB de Nintendo"
#define OPTION_VAL_YUV_V3_ES "YUV-V3 de FBX"
#define OPTION_VAL_UNSATURATED_FINAL_ES "Final sin saturación de FBX"
#define OPTION_VAL_SONY_CXA2025AS_US_ES "Sony CXA2025AS de EE. UU."
#define OPTION_VAL_PAL_ES NULL
#define OPTION_VAL_BMF_FINAL2_ES "Final 2 de BMF"
#define OPTION_VAL_BMF_FINAL3_ES "Final 3 de BMF"
#define OPTION_VAL_SMOOTH_FBX_ES "Suavizada de FBX"
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_ES "Señal directa de vídeo compuesto de FBX"
#define OPTION_VAL_PVM_STYLE_D93_FBX_ES "PVM estilo D93 de FBX"
#define OPTION_VAL_NTSC_HARDWARE_FBX_ES "Hardware NTSC de FBX"
#define OPTION_VAL_NES_CLASSIC_FBX_FS_ES "NES Classic de FBX (corregida)"
#define OPTION_VAL_NESCAP_ES "NESCAP de RGBSource"
#define OPTION_VAL_WAVEBEAM_ES "Wavebeam de nakedarthur"
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_ES "Desactivar límite de sprites"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_ES "Elimina el límite de ocho sprites por línea de barrido que tenía el hardware original. Reduce los parpadeos, pero puede provocar fallos gráficos, ya que algunos juegos aprovechan esta limitación para generar efectos especiales."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_ES "Modo de audio"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_ES "Configura la emulación de audio. «No lineal» simula la mezcla de canales no lineal de la APU de NES. «Lineal» utilizará una aproximación menos fiel, reduciendo la calidad pero mejorando el rendimiento en hardware poco potente. «Panoramizar a estéreo» añade más profundidad a la salida mono de NES mediante el uso de técnicas de paneo (panoramización) y efectos de reverberación."
#define OPTION_VAL_NONLINEAR_ES "No lineal"
#define OPTION_VAL_LINEAR_ES "Lineal"
#define OPTION_VAL_STEREO_PANNING_ES "Panoramizar a estéreo"
#define QUICKNES_AUDIO_EQ_LABEL_ES "Preajuste del ecualizador de audio"
#define QUICKNES_AUDIO_EQ_INFO_0_ES "Afina el equilibrio entre cada componente de frecuencia de audio con un preajuste personalizado de ecualización."
#define OPTION_VAL_FAMICOM_ES NULL
#define OPTION_VAL_TV_ES "Televisor"
#define OPTION_VAL_FLAT_ES "Puro"
#define OPTION_VAL_CRISP_ES "Nítido"
#define OPTION_VAL_TINNY_ES "Metálico"
#define QUICKNES_TURBO_ENABLE_LABEL_ES "Botones turbo"
#define QUICKNES_TURBO_ENABLE_INFO_0_ES "Permite usar los botones Turbo A y Turbo B."
#define OPTION_VAL_NONE_ES "Ninguno"
#define OPTION_VAL_PLAYER_1_ES "Jugador 1"
#define OPTION_VAL_PLAYER_2_ES "Jugador 2"
#define OPTION_VAL_BOTH_ES "Jugadores 1 y 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_ES "Longitud de pulsación de turbo (en fotogramas)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_ES "Especifica tanto la duración de pulsación como la de no pulsación (en fotogramas) cuando se aprieten los botones Turbo A y Turbo B. Por ejemplo, el valor predeterminado de 3 se corresponde a la fórmula (60 ÷ (3 + 3)) = frecuencia de 10 Hz del turbo (10 pulsaciones por segundo)."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_ES "Permitir direcciones opuestas"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_ES "Esta opción permitirá pulsar, alternar rápidamente o mantener las direcciones izquierda y derecha (o arriba y abajo) al mismo tiempo. Podría provocar fallos de movimiento."

struct retro_core_option_v2_category option_cats_es[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_es[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_ES,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_ES,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_ES },
         { "4:3", OPTION_VAL_4_3_ES },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_ES,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_ES,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_ES,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_ES,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_ES,
      NULL,
      QUICKNES_PALETTE_INFO_0_ES,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_ES },
         { "asqrealc",             OPTION_VAL_ASQREALC_ES },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_ES },
         { "rgb",                  OPTION_VAL_RGB_ES },
         { "yuv-v3",               OPTION_VAL_YUV_V3_ES },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_ES },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_ES },
         { "pal",                  OPTION_VAL_PAL_ES },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_ES },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_ES },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_ES },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_ES },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_ES },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_ES },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_ES },
         { "nescap",               OPTION_VAL_NESCAP_ES },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_ES },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_ES,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_ES,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_ES,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_ES,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_ES },
         { "linear",         OPTION_VAL_LINEAR_ES },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_ES },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_ES,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_ES,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_ES },
         { "famicom", OPTION_VAL_FAMICOM_ES },
         { "tv",      OPTION_VAL_TV_ES },
         { "flat",    OPTION_VAL_FLAT_ES },
         { "crisp",   OPTION_VAL_CRISP_ES },
         { "tinny",   OPTION_VAL_TINNY_ES },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_ES,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_ES,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_ES },
         { "player 1", OPTION_VAL_PLAYER_1_ES },
         { "player 2", OPTION_VAL_PLAYER_2_ES },
         { "both",     OPTION_VAL_BOTH_ES },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_ES,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_ES,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_ES,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_ES,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_es = {
   option_cats_es,
   option_defs_es
};

/* RETRO_LANGUAGE_FA */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_FA "نسبت تصویر"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_FA NULL
#define OPTION_VAL_PAR_FA NULL
#define OPTION_VAL_4_3_FA NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_FA NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_FA NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_FA NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_FA NULL
#define QUICKNES_PALETTE_LABEL_FA NULL
#define QUICKNES_PALETTE_INFO_0_FA NULL
#define OPTION_VAL_DEFAULT_FA NULL
#define OPTION_VAL_ASQREALC_FA NULL
#define OPTION_VAL_NINTENDO_VC_FA NULL
#define OPTION_VAL_RGB_FA NULL
#define OPTION_VAL_YUV_V3_FA NULL
#define OPTION_VAL_UNSATURATED_FINAL_FA NULL
#define OPTION_VAL_SONY_CXA2025AS_US_FA NULL
#define OPTION_VAL_PAL_FA NULL
#define OPTION_VAL_BMF_FINAL2_FA NULL
#define OPTION_VAL_BMF_FINAL3_FA NULL
#define OPTION_VAL_SMOOTH_FBX_FA NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_FA NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_FA NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_FA NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_FA NULL
#define OPTION_VAL_NESCAP_FA NULL
#define OPTION_VAL_WAVEBEAM_FA NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_FA NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_FA NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_FA NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_FA NULL
#define OPTION_VAL_NONLINEAR_FA NULL
#define OPTION_VAL_LINEAR_FA NULL
#define OPTION_VAL_STEREO_PANNING_FA NULL
#define QUICKNES_AUDIO_EQ_LABEL_FA NULL
#define QUICKNES_AUDIO_EQ_INFO_0_FA NULL
#define OPTION_VAL_FAMICOM_FA NULL
#define OPTION_VAL_TV_FA NULL
#define OPTION_VAL_FLAT_FA NULL
#define OPTION_VAL_CRISP_FA NULL
#define OPTION_VAL_TINNY_FA NULL
#define QUICKNES_TURBO_ENABLE_LABEL_FA NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_FA NULL
#define OPTION_VAL_NONE_FA "هیچکدام"
#define OPTION_VAL_PLAYER_1_FA NULL
#define OPTION_VAL_PLAYER_2_FA NULL
#define OPTION_VAL_BOTH_FA NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_FA NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_FA NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_FA NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_FA NULL

struct retro_core_option_v2_category option_cats_fa[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_fa[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_FA,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_FA,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_FA },
         { "4:3", OPTION_VAL_4_3_FA },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_FA,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_FA,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_FA,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_FA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_FA,
      NULL,
      QUICKNES_PALETTE_INFO_0_FA,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_FA },
         { "asqrealc",             OPTION_VAL_ASQREALC_FA },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_FA },
         { "rgb",                  OPTION_VAL_RGB_FA },
         { "yuv-v3",               OPTION_VAL_YUV_V3_FA },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_FA },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_FA },
         { "pal",                  OPTION_VAL_PAL_FA },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_FA },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_FA },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_FA },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_FA },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_FA },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_FA },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_FA },
         { "nescap",               OPTION_VAL_NESCAP_FA },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_FA },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_FA,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_FA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_FA,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_FA,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_FA },
         { "linear",         OPTION_VAL_LINEAR_FA },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_FA },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_FA,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_FA,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_FA },
         { "famicom", OPTION_VAL_FAMICOM_FA },
         { "tv",      OPTION_VAL_TV_FA },
         { "flat",    OPTION_VAL_FLAT_FA },
         { "crisp",   OPTION_VAL_CRISP_FA },
         { "tinny",   OPTION_VAL_TINNY_FA },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_FA,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_FA,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_FA },
         { "player 1", OPTION_VAL_PLAYER_1_FA },
         { "player 2", OPTION_VAL_PLAYER_2_FA },
         { "both",     OPTION_VAL_BOTH_FA },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_FA,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_FA,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_FA,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_FA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_fa = {
   option_cats_fa,
   option_defs_fa
};

/* RETRO_LANGUAGE_FI */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_FI "Kuvasuhde"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_FI "Tämä pätee vain kun RetroArchin kuvasuhde on asetettu \"Ydin\" valintaan video asetuksissa."
#define OPTION_VAL_PAR_FI NULL
#define OPTION_VAL_4_3_FI NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_FI "Näytä vaakasuora yliskannaus"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_FI "Poista tämä käytöstä rajataksesi (vaakasuora) vääristynyt videon ulostulo, joka olisi jäänyt piiloon kehysten reunan taakse perinteisen tarkkuuden näytöllä."
#define QUICKNES_USE_OVERSCAN_V_LABEL_FI "Näytä pystysuora yliskannaus"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_FI "Poista tämä käytöstä rajataksesi (pystysuora) vääristynyt videon ulostulo, joka olisi jäänyt piiloon kehysten reunan taakse perinteisen tarkkuuden näytöllä."
#define QUICKNES_PALETTE_LABEL_FI "Väripaletti"
#define QUICKNES_PALETTE_INFO_0_FI "Määrittää, mitä väripalettia käytetään, kun NTSC-videosignaalin ulostulo puretaan NES:llä."
#define OPTION_VAL_DEFAULT_FI "Oletus"
#define OPTION_VAL_ASQREALC_FI NULL
#define OPTION_VAL_NINTENDO_VC_FI NULL
#define OPTION_VAL_RGB_FI NULL
#define OPTION_VAL_YUV_V3_FI NULL
#define OPTION_VAL_UNSATURATED_FINAL_FI NULL
#define OPTION_VAL_SONY_CXA2025AS_US_FI NULL
#define OPTION_VAL_PAL_FI NULL
#define OPTION_VAL_BMF_FINAL2_FI NULL
#define OPTION_VAL_BMF_FINAL3_FI NULL
#define OPTION_VAL_SMOOTH_FBX_FI NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_FI NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_FI NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_FI "FBX:n NTSC laitteisto"
#define OPTION_VAL_NES_CLASSIC_FBX_FS_FI "FBX:n NES-Classic (korjattu)"
#define OPTION_VAL_NESCAP_FI NULL
#define OPTION_VAL_WAVEBEAM_FI NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_FI "Poista sprite-rajoitus"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_FI "Poistaa 8 spriten vaakasuuntaisen laitteistorajoituksen. Tämä vähentää välkkymistä, mutta voi aiheuttaa visuaalisia virheitä, koska jotkut pelit hyödyntävät laitteistorajoja tuottamaan erikoistehosteita."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_FI "Äänen tila"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_FI "Määritä äänen emulointi. \"Epälineaarinen\" simuloi NES-APU:n epälineaarista kanavayhdistelmää. \"Lineaarinen\" käyttää vähemmän tarkkaa lähestymistä, mikä vähentää äänenlaatua mutta lisää suorituskykyä heikkotehoisilla laitteilla. \"Stereo panerointi\" lisää syvyyttä NES mono ulostuloon käyttämällä panerointi tekniikoita ja kaiku tehosteita."
#define OPTION_VAL_NONLINEAR_FI "Epälineaarinen"
#define OPTION_VAL_LINEAR_FI "Lineaarinen"
#define OPTION_VAL_STEREO_PANNING_FI "Stereo panerointi"
#define QUICKNES_AUDIO_EQ_LABEL_FI "Äänen taajuuskorjaimen esiasetus"
#define QUICKNES_AUDIO_EQ_INFO_0_FI "Säädä tasapainoa äänen taajuuskomponenttien välillä mukautetulla taajuuskorjaimen esiasetuksella."
#define OPTION_VAL_FAMICOM_FI NULL
#define OPTION_VAL_TV_FI NULL
#define OPTION_VAL_FLAT_FI "Litteä"
#define OPTION_VAL_CRISP_FI NULL
#define OPTION_VAL_TINNY_FI NULL
#define QUICKNES_TURBO_ENABLE_LABEL_FI "Ota turbo käyttöön"
#define QUICKNES_TURBO_ENABLE_INFO_0_FI "Mahdollistaa Turbo A- ja Turbo B -painikkeiden käytön."
#define OPTION_VAL_NONE_FI "Ei mitään"
#define OPTION_VAL_PLAYER_1_FI "Pelaaja 1"
#define OPTION_VAL_PLAYER_2_FI "Pelaaja 2"
#define OPTION_VAL_BOTH_FI "Pelaajat 1 ja 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_FI "Turbo pulssin leveys (kehyksissä)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_FI "Määrittää turbon \"syötepulssin\" leveyden ja välityksen (kehyksissä), kun Turbo A- ja Turbo B -painikkeita pidetään alhaalla. Esimerkiksi \"3\" oletusasetus vastaa arvoa (60/(3+3)) = 10 Hz turbotaajuutta (10 painallusta sekunnissa)."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_FI "Salli vastakkaiset suunnat"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_FI "Tämän käyttöönotto sallii painamaan / nopeasti vaihtelemaan / pitämään sekä vasemmalle että oikealle (tai ylös ja alas) samanaikaisesti. Tämä voi aiheuttaa liikkeisiin perustuvia virheitä."

struct retro_core_option_v2_category option_cats_fi[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_fi[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_FI,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_FI,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_FI },
         { "4:3", OPTION_VAL_4_3_FI },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_FI,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_FI,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_FI,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_FI,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_FI,
      NULL,
      QUICKNES_PALETTE_INFO_0_FI,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_FI },
         { "asqrealc",             OPTION_VAL_ASQREALC_FI },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_FI },
         { "rgb",                  OPTION_VAL_RGB_FI },
         { "yuv-v3",               OPTION_VAL_YUV_V3_FI },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_FI },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_FI },
         { "pal",                  OPTION_VAL_PAL_FI },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_FI },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_FI },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_FI },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_FI },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_FI },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_FI },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_FI },
         { "nescap",               OPTION_VAL_NESCAP_FI },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_FI },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_FI,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_FI,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_FI,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_FI,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_FI },
         { "linear",         OPTION_VAL_LINEAR_FI },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_FI },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_FI,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_FI,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_FI },
         { "famicom", OPTION_VAL_FAMICOM_FI },
         { "tv",      OPTION_VAL_TV_FI },
         { "flat",    OPTION_VAL_FLAT_FI },
         { "crisp",   OPTION_VAL_CRISP_FI },
         { "tinny",   OPTION_VAL_TINNY_FI },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_FI,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_FI,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_FI },
         { "player 1", OPTION_VAL_PLAYER_1_FI },
         { "player 2", OPTION_VAL_PLAYER_2_FI },
         { "both",     OPTION_VAL_BOTH_FI },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_FI,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_FI,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_FI,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_FI,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_fi = {
   option_cats_fi,
   option_defs_fi
};

/* RETRO_LANGUAGE_FR */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_FR "Rapport d'aspect"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_FR "Cette option ne s'applique que lorsque le rapport d'aspect de RetroArch est réglé sur 'Fourni par le cœur' (Core provided) dans les réglages Vidéo."
#define OPTION_VAL_PAR_FR "PAR (rapport d'aspect des pixels)"
#define OPTION_VAL_4_3_FR NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_FR "Afficher le surbalayage horizontal"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_FR "Désactiver cette option pour recadrer (horizontalement) la sortie vidéo potentiellement buggée et aléatoire qui aurait été cachée par le biseau autour du bord d'un écran de télévision définition standard."
#define QUICKNES_USE_OVERSCAN_V_LABEL_FR "Afficher le surbalayage vertical"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_FR "Désactiver cette option pour recadrer (verticalement) la sortie vidéo potentiellement buggée et aléatoire qui aurait été cachée par le biseau autour du bord d'un écran de télévision définition standard."
#define QUICKNES_PALETTE_LABEL_FR "Palette de couleurs"
#define QUICKNES_PALETTE_INFO_0_FR "Spécifie la palette de couleurs à utiliser lors du décodage du signal vidéo NTSC par la NES."
#define OPTION_VAL_DEFAULT_FR "Par défaut"
#define OPTION_VAL_ASQREALC_FR "Réelle par AspiringSquire"
#define OPTION_VAL_NINTENDO_VC_FR "Console virtuelle Nintendo"
#define OPTION_VAL_RGB_FR "PPU RVB Nintendo"
#define OPTION_VAL_YUV_V3_FR "YUV-V3 de FBX"
#define OPTION_VAL_UNSATURATED_FINAL_FR "Finale non saturée de FBX"
#define OPTION_VAL_SONY_CXA2025AS_US_FR NULL
#define OPTION_VAL_PAL_FR NULL
#define OPTION_VAL_BMF_FINAL2_FR "Finale 2 de BMF"
#define OPTION_VAL_BMF_FINAL3_FR "Finale 3 de BMF"
#define OPTION_VAL_SMOOTH_FBX_FR "Lisse de FBX"
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_FR "Composite directe de FBX"
#define OPTION_VAL_PVM_STYLE_D93_FBX_FR "Style PVM D93 de FBX"
#define OPTION_VAL_NTSC_HARDWARE_FBX_FR "Matériel NTSC de FBX"
#define OPTION_VAL_NES_CLASSIC_FBX_FS_FR "NES Classic (corrigée) de FBX"
#define OPTION_VAL_NESCAP_FR "NESCAP de RGBSource"
#define OPTION_VAL_WAVEBEAM_FR "Wavebeam de nakedarthur"
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_FR "Aucune limite de sprites"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_FR "Supprime la limite matérielle de 8 sprites par ligne de balayage. Cela réduit le scintillement mais peut causer des bugs visuels, car certains jeux exploitent la limite matérielle pour générer des effets spéciaux."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_FR "Mode audio"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_FR "Configurer l'émulation audio. 'Non linéaire' simule le mélange des canaux non-linéaire de l'APU de la NES. 'Linéaire' utilise une approximation moins précise, ce qui réduit la qualité mais augmente les performances sur du matériel de bas de gamme. Le 'Panoramique stéréo' ajoute de la profondeur à la sortie mono de la NES grâce à l'utilisation de techniques de panoramique et d'effets de réverbération."
#define OPTION_VAL_NONLINEAR_FR "Non linéaire"
#define OPTION_VAL_LINEAR_FR "Linéaire"
#define OPTION_VAL_STEREO_PANNING_FR "Panoramique stéréo"
#define QUICKNES_AUDIO_EQ_LABEL_FR "Préréglage de l'égaliseur audio"
#define QUICKNES_AUDIO_EQ_INFO_0_FR "Ajuster l'équilibre entre les composants de la fréquence audio avec un préréglage d'égaliseur personnalisé."
#define OPTION_VAL_FAMICOM_FR NULL
#define OPTION_VAL_TV_FR NULL
#define OPTION_VAL_FLAT_FR "Plat"
#define OPTION_VAL_CRISP_FR "Net"
#define OPTION_VAL_TINNY_FR "Métallique"
#define QUICKNES_TURBO_ENABLE_LABEL_FR "Activer le turbo"
#define QUICKNES_TURBO_ENABLE_INFO_0_FR "Active l'utilisation des touches Turbo A et Turbo B."
#define OPTION_VAL_NONE_FR "Aucun"
#define OPTION_VAL_PLAYER_1_FR "Joueur 1"
#define OPTION_VAL_PLAYER_2_FR "Joueur 2"
#define OPTION_VAL_BOTH_FR "Joueur 1 & 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_FR "Largeur d'impulsion du turbo (en images)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_FR "Spécifie la largeur et l'espacement (en images) des 'impulsions' d'entrée lorsque les touches Turbo A et Turbo B sont maintenus enfoncés. Par exemple, le réglage par défaut de '3' correspond à une fréquence turbo de (60/(3+3)) = 10 Hz (10 pressions par seconde)."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_FR "Autoriser les directions opposées"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_FR "L'activation de cette option permettra d'appuyer/d'alterner rapidement/de maintenir les directions gauche et droite (ou haut et bas) en même temps. Cela peut causer des bugs liés au mouvement."

struct retro_core_option_v2_category option_cats_fr[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_fr[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_FR,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_FR,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_FR },
         { "4:3", OPTION_VAL_4_3_FR },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_FR,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_FR,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_FR,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_FR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_FR,
      NULL,
      QUICKNES_PALETTE_INFO_0_FR,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_FR },
         { "asqrealc",             OPTION_VAL_ASQREALC_FR },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_FR },
         { "rgb",                  OPTION_VAL_RGB_FR },
         { "yuv-v3",               OPTION_VAL_YUV_V3_FR },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_FR },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_FR },
         { "pal",                  OPTION_VAL_PAL_FR },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_FR },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_FR },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_FR },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_FR },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_FR },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_FR },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_FR },
         { "nescap",               OPTION_VAL_NESCAP_FR },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_FR },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_FR,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_FR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_FR,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_FR,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_FR },
         { "linear",         OPTION_VAL_LINEAR_FR },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_FR },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_FR,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_FR,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_FR },
         { "famicom", OPTION_VAL_FAMICOM_FR },
         { "tv",      OPTION_VAL_TV_FR },
         { "flat",    OPTION_VAL_FLAT_FR },
         { "crisp",   OPTION_VAL_CRISP_FR },
         { "tinny",   OPTION_VAL_TINNY_FR },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_FR,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_FR,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_FR },
         { "player 1", OPTION_VAL_PLAYER_1_FR },
         { "player 2", OPTION_VAL_PLAYER_2_FR },
         { "both",     OPTION_VAL_BOTH_FR },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_FR,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_FR,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_FR,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_FR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_fr = {
   option_cats_fr,
   option_defs_fr
};

/* RETRO_LANGUAGE_GL */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_GL NULL
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_GL NULL
#define OPTION_VAL_PAR_GL NULL
#define OPTION_VAL_4_3_GL NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_GL NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_GL NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_GL NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_GL NULL
#define QUICKNES_PALETTE_LABEL_GL NULL
#define QUICKNES_PALETTE_INFO_0_GL NULL
#define OPTION_VAL_DEFAULT_GL NULL
#define OPTION_VAL_ASQREALC_GL NULL
#define OPTION_VAL_NINTENDO_VC_GL NULL
#define OPTION_VAL_RGB_GL NULL
#define OPTION_VAL_YUV_V3_GL NULL
#define OPTION_VAL_UNSATURATED_FINAL_GL NULL
#define OPTION_VAL_SONY_CXA2025AS_US_GL NULL
#define OPTION_VAL_PAL_GL NULL
#define OPTION_VAL_BMF_FINAL2_GL NULL
#define OPTION_VAL_BMF_FINAL3_GL NULL
#define OPTION_VAL_SMOOTH_FBX_GL NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_GL NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_GL NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_GL NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_GL NULL
#define OPTION_VAL_NESCAP_GL NULL
#define OPTION_VAL_WAVEBEAM_GL NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_GL NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_GL NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_GL NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_GL NULL
#define OPTION_VAL_NONLINEAR_GL NULL
#define OPTION_VAL_LINEAR_GL NULL
#define OPTION_VAL_STEREO_PANNING_GL NULL
#define QUICKNES_AUDIO_EQ_LABEL_GL NULL
#define QUICKNES_AUDIO_EQ_INFO_0_GL NULL
#define OPTION_VAL_FAMICOM_GL NULL
#define OPTION_VAL_TV_GL NULL
#define OPTION_VAL_FLAT_GL NULL
#define OPTION_VAL_CRISP_GL NULL
#define OPTION_VAL_TINNY_GL NULL
#define QUICKNES_TURBO_ENABLE_LABEL_GL NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_GL NULL
#define OPTION_VAL_NONE_GL "Ningún"
#define OPTION_VAL_PLAYER_1_GL NULL
#define OPTION_VAL_PLAYER_2_GL NULL
#define OPTION_VAL_BOTH_GL NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_GL NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_GL NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_GL NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_GL NULL

struct retro_core_option_v2_category option_cats_gl[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_gl[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_GL,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_GL,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_GL },
         { "4:3", OPTION_VAL_4_3_GL },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_GL,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_GL,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_GL,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_GL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_GL,
      NULL,
      QUICKNES_PALETTE_INFO_0_GL,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_GL },
         { "asqrealc",             OPTION_VAL_ASQREALC_GL },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_GL },
         { "rgb",                  OPTION_VAL_RGB_GL },
         { "yuv-v3",               OPTION_VAL_YUV_V3_GL },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_GL },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_GL },
         { "pal",                  OPTION_VAL_PAL_GL },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_GL },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_GL },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_GL },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_GL },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_GL },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_GL },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_GL },
         { "nescap",               OPTION_VAL_NESCAP_GL },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_GL },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_GL,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_GL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_GL,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_GL,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_GL },
         { "linear",         OPTION_VAL_LINEAR_GL },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_GL },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_GL,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_GL,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_GL },
         { "famicom", OPTION_VAL_FAMICOM_GL },
         { "tv",      OPTION_VAL_TV_GL },
         { "flat",    OPTION_VAL_FLAT_GL },
         { "crisp",   OPTION_VAL_CRISP_GL },
         { "tinny",   OPTION_VAL_TINNY_GL },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_GL,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_GL,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_GL },
         { "player 1", OPTION_VAL_PLAYER_1_GL },
         { "player 2", OPTION_VAL_PLAYER_2_GL },
         { "both",     OPTION_VAL_BOTH_GL },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_GL,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_GL,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_GL,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_GL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_gl = {
   option_cats_gl,
   option_defs_gl
};

/* RETRO_LANGUAGE_HE */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_HE "יחס גובה-רוחב"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_HE NULL
#define OPTION_VAL_PAR_HE NULL
#define OPTION_VAL_4_3_HE NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_HE NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_HE NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_HE NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_HE NULL
#define QUICKNES_PALETTE_LABEL_HE NULL
#define QUICKNES_PALETTE_INFO_0_HE NULL
#define OPTION_VAL_DEFAULT_HE NULL
#define OPTION_VAL_ASQREALC_HE NULL
#define OPTION_VAL_NINTENDO_VC_HE NULL
#define OPTION_VAL_RGB_HE NULL
#define OPTION_VAL_YUV_V3_HE NULL
#define OPTION_VAL_UNSATURATED_FINAL_HE NULL
#define OPTION_VAL_SONY_CXA2025AS_US_HE NULL
#define OPTION_VAL_PAL_HE NULL
#define OPTION_VAL_BMF_FINAL2_HE NULL
#define OPTION_VAL_BMF_FINAL3_HE NULL
#define OPTION_VAL_SMOOTH_FBX_HE NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_HE NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_HE NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_HE NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_HE NULL
#define OPTION_VAL_NESCAP_HE NULL
#define OPTION_VAL_WAVEBEAM_HE NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_HE NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_HE NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_HE NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_HE NULL
#define OPTION_VAL_NONLINEAR_HE NULL
#define OPTION_VAL_LINEAR_HE NULL
#define OPTION_VAL_STEREO_PANNING_HE NULL
#define QUICKNES_AUDIO_EQ_LABEL_HE NULL
#define QUICKNES_AUDIO_EQ_INFO_0_HE NULL
#define OPTION_VAL_FAMICOM_HE NULL
#define OPTION_VAL_TV_HE NULL
#define OPTION_VAL_FLAT_HE NULL
#define OPTION_VAL_CRISP_HE NULL
#define OPTION_VAL_TINNY_HE NULL
#define QUICKNES_TURBO_ENABLE_LABEL_HE NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_HE NULL
#define OPTION_VAL_NONE_HE NULL
#define OPTION_VAL_PLAYER_1_HE NULL
#define OPTION_VAL_PLAYER_2_HE NULL
#define OPTION_VAL_BOTH_HE NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_HE NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_HE NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_HE NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_HE NULL

struct retro_core_option_v2_category option_cats_he[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_he[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_HE,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_HE,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_HE },
         { "4:3", OPTION_VAL_4_3_HE },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_HE,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_HE,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_HE,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_HE,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_HE,
      NULL,
      QUICKNES_PALETTE_INFO_0_HE,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_HE },
         { "asqrealc",             OPTION_VAL_ASQREALC_HE },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_HE },
         { "rgb",                  OPTION_VAL_RGB_HE },
         { "yuv-v3",               OPTION_VAL_YUV_V3_HE },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_HE },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_HE },
         { "pal",                  OPTION_VAL_PAL_HE },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_HE },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_HE },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_HE },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_HE },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_HE },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_HE },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_HE },
         { "nescap",               OPTION_VAL_NESCAP_HE },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_HE },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_HE,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_HE,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_HE,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_HE,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_HE },
         { "linear",         OPTION_VAL_LINEAR_HE },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_HE },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_HE,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_HE,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_HE },
         { "famicom", OPTION_VAL_FAMICOM_HE },
         { "tv",      OPTION_VAL_TV_HE },
         { "flat",    OPTION_VAL_FLAT_HE },
         { "crisp",   OPTION_VAL_CRISP_HE },
         { "tinny",   OPTION_VAL_TINNY_HE },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_HE,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_HE,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_HE },
         { "player 1", OPTION_VAL_PLAYER_1_HE },
         { "player 2", OPTION_VAL_PLAYER_2_HE },
         { "both",     OPTION_VAL_BOTH_HE },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_HE,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_HE,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_HE,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_HE,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_he = {
   option_cats_he,
   option_defs_he
};

/* RETRO_LANGUAGE_HR */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_HR "Omjer slike"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_HR NULL
#define OPTION_VAL_PAR_HR NULL
#define OPTION_VAL_4_3_HR NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_HR NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_HR NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_HR NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_HR NULL
#define QUICKNES_PALETTE_LABEL_HR NULL
#define QUICKNES_PALETTE_INFO_0_HR NULL
#define OPTION_VAL_DEFAULT_HR NULL
#define OPTION_VAL_ASQREALC_HR NULL
#define OPTION_VAL_NINTENDO_VC_HR NULL
#define OPTION_VAL_RGB_HR NULL
#define OPTION_VAL_YUV_V3_HR NULL
#define OPTION_VAL_UNSATURATED_FINAL_HR NULL
#define OPTION_VAL_SONY_CXA2025AS_US_HR NULL
#define OPTION_VAL_PAL_HR NULL
#define OPTION_VAL_BMF_FINAL2_HR NULL
#define OPTION_VAL_BMF_FINAL3_HR NULL
#define OPTION_VAL_SMOOTH_FBX_HR NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_HR NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_HR NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_HR NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_HR NULL
#define OPTION_VAL_NESCAP_HR NULL
#define OPTION_VAL_WAVEBEAM_HR NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_HR NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_HR NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_HR NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_HR NULL
#define OPTION_VAL_NONLINEAR_HR NULL
#define OPTION_VAL_LINEAR_HR NULL
#define OPTION_VAL_STEREO_PANNING_HR NULL
#define QUICKNES_AUDIO_EQ_LABEL_HR NULL
#define QUICKNES_AUDIO_EQ_INFO_0_HR NULL
#define OPTION_VAL_FAMICOM_HR NULL
#define OPTION_VAL_TV_HR NULL
#define OPTION_VAL_FLAT_HR NULL
#define OPTION_VAL_CRISP_HR NULL
#define OPTION_VAL_TINNY_HR NULL
#define QUICKNES_TURBO_ENABLE_LABEL_HR NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_HR NULL
#define OPTION_VAL_NONE_HR NULL
#define OPTION_VAL_PLAYER_1_HR NULL
#define OPTION_VAL_PLAYER_2_HR NULL
#define OPTION_VAL_BOTH_HR NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_HR NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_HR NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_HR NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_HR NULL

struct retro_core_option_v2_category option_cats_hr[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_hr[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_HR,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_HR,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_HR },
         { "4:3", OPTION_VAL_4_3_HR },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_HR,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_HR,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_HR,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_HR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_HR,
      NULL,
      QUICKNES_PALETTE_INFO_0_HR,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_HR },
         { "asqrealc",             OPTION_VAL_ASQREALC_HR },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_HR },
         { "rgb",                  OPTION_VAL_RGB_HR },
         { "yuv-v3",               OPTION_VAL_YUV_V3_HR },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_HR },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_HR },
         { "pal",                  OPTION_VAL_PAL_HR },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_HR },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_HR },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_HR },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_HR },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_HR },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_HR },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_HR },
         { "nescap",               OPTION_VAL_NESCAP_HR },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_HR },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_HR,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_HR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_HR,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_HR,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_HR },
         { "linear",         OPTION_VAL_LINEAR_HR },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_HR },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_HR,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_HR,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_HR },
         { "famicom", OPTION_VAL_FAMICOM_HR },
         { "tv",      OPTION_VAL_TV_HR },
         { "flat",    OPTION_VAL_FLAT_HR },
         { "crisp",   OPTION_VAL_CRISP_HR },
         { "tinny",   OPTION_VAL_TINNY_HR },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_HR,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_HR,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_HR },
         { "player 1", OPTION_VAL_PLAYER_1_HR },
         { "player 2", OPTION_VAL_PLAYER_2_HR },
         { "both",     OPTION_VAL_BOTH_HR },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_HR,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_HR,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_HR,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_HR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_hr = {
   option_cats_hr,
   option_defs_hr
};

/* RETRO_LANGUAGE_HU */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_HU "Képarány"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_HU "Csak akkor lép életbe, ha a RetroArch képaránya \"Mag által megadott\"-ra van állítva a képbeállításoknál."
#define OPTION_VAL_PAR_HU NULL
#define OPTION_VAL_4_3_HU NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_HU "Vízszintes overscan megjelenítése"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_HU "Kikapcsolva a kép vízszintes szélei, amelyeket egy normál felbontású tévékészülék kávája kitakart és esetleg hibás képkimenetet tartalmaznak, nem jelennek meg."
#define QUICKNES_USE_OVERSCAN_V_LABEL_HU "Függőleges overscan megjelenítése"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_HU "Kikapcsolva a kép függőleges szélei, amelyeket egy normál felbontású tévékészülék kávája kitakart és esetleg hibás képkimenetet tartalmaznak, nem jelennek meg."
#define QUICKNES_PALETTE_LABEL_HU "Színpaletta"
#define QUICKNES_PALETTE_INFO_0_HU "A NES NTSC videójel kimenetének dekódolásakor használt színpaletta."
#define OPTION_VAL_DEFAULT_HU "Alapértelmezett"
#define OPTION_VAL_ASQREALC_HU NULL
#define OPTION_VAL_NINTENDO_VC_HU NULL
#define OPTION_VAL_RGB_HU NULL
#define OPTION_VAL_YUV_V3_HU NULL
#define OPTION_VAL_UNSATURATED_FINAL_HU NULL
#define OPTION_VAL_SONY_CXA2025AS_US_HU NULL
#define OPTION_VAL_PAL_HU NULL
#define OPTION_VAL_BMF_FINAL2_HU NULL
#define OPTION_VAL_BMF_FINAL3_HU NULL
#define OPTION_VAL_SMOOTH_FBX_HU NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_HU NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_HU NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_HU NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_HU "FBX's NES-Classic (javított)"
#define OPTION_VAL_NESCAP_HU NULL
#define OPTION_VAL_WAVEBEAM_HU NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_HU "Nincs sprite korlátozás"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_HU "Megszünteti a hardver soronkénti maximum 8 sprite-os korlátozását. Csökkenti a villódzást, de grafikai hibákat okozhat, mivel néhány játék a hardverkorlátozást speciális effektekhez használja fel."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_HU "Hang mód"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_HU "A hangemuláció beállítása. A Nemlineáris a NES APU nem-lineáris csatornakeverését szimulálja. A Lineáris kevésbé pontos közelítést alkalmaz, ami csökkenti a minőséget, de javítja a teljesítményt gyenge hardveren. A Sztereó panoráma mélységet ad a NES monó kimenetének, panoráma és visszhang effektek használatával."
#define OPTION_VAL_NONLINEAR_HU "Nemlineáris"
#define OPTION_VAL_LINEAR_HU "Lineáris"
#define OPTION_VAL_STEREO_PANNING_HU "Sztereó panoráma"
#define QUICKNES_AUDIO_EQ_LABEL_HU "Hangszínszabályzó beállítása"
#define QUICKNES_AUDIO_EQ_INFO_0_HU "A hang frekvenciakomponensei közti egyensúly állítása egyedi hangszínszabályzó beállítással."
#define OPTION_VAL_FAMICOM_HU NULL
#define OPTION_VAL_TV_HU NULL
#define OPTION_VAL_FLAT_HU "Egyenes"
#define OPTION_VAL_CRISP_HU "Éles"
#define OPTION_VAL_TINNY_HU "Bádoghang"
#define QUICKNES_TURBO_ENABLE_LABEL_HU "Turbó engedélyezése"
#define QUICKNES_TURBO_ENABLE_INFO_0_HU "A Turbo A és Turbo B gombok használatának engedélyezése."
#define OPTION_VAL_NONE_HU "Nincs"
#define OPTION_VAL_PLAYER_1_HU "1. játékos"
#define OPTION_VAL_PLAYER_2_HU "2. játékos"
#define OPTION_VAL_BOTH_HU "1. és 2. játékos"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_HU "Turbó pulzus szélessége (képkockában)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_HU "A bemeneti \"pulzusok\" szélessége és távolsága a Turbo A és Turbo B gombok nyomva tartásakor. Például, az alapértelmezett 3-as beállítás egy (60/(3+3)) = 10 Hz-es turbó frekvenciának felel meg (másodpercenként 10 lenyomás)."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_HU "Ellentétes irányok engedélyezése"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_HU "A jobb és bal (vagy fel és le) irányok egyidejű/gyorsan váltakozó lenyomásának vagy nyomva tartásának engedélyezése. Hibákat okozhat a mozgatásban."

struct retro_core_option_v2_category option_cats_hu[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_hu[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_HU,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_HU,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_HU },
         { "4:3", OPTION_VAL_4_3_HU },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_HU,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_HU,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_HU,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_HU,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_HU,
      NULL,
      QUICKNES_PALETTE_INFO_0_HU,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_HU },
         { "asqrealc",             OPTION_VAL_ASQREALC_HU },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_HU },
         { "rgb",                  OPTION_VAL_RGB_HU },
         { "yuv-v3",               OPTION_VAL_YUV_V3_HU },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_HU },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_HU },
         { "pal",                  OPTION_VAL_PAL_HU },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_HU },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_HU },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_HU },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_HU },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_HU },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_HU },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_HU },
         { "nescap",               OPTION_VAL_NESCAP_HU },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_HU },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_HU,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_HU,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_HU,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_HU,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_HU },
         { "linear",         OPTION_VAL_LINEAR_HU },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_HU },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_HU,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_HU,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_HU },
         { "famicom", OPTION_VAL_FAMICOM_HU },
         { "tv",      OPTION_VAL_TV_HU },
         { "flat",    OPTION_VAL_FLAT_HU },
         { "crisp",   OPTION_VAL_CRISP_HU },
         { "tinny",   OPTION_VAL_TINNY_HU },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_HU,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_HU,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_HU },
         { "player 1", OPTION_VAL_PLAYER_1_HU },
         { "player 2", OPTION_VAL_PLAYER_2_HU },
         { "both",     OPTION_VAL_BOTH_HU },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_HU,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_HU,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_HU,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_HU,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_hu = {
   option_cats_hu,
   option_defs_hu
};

/* RETRO_LANGUAGE_ID */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_ID "Rasio Aspek"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_ID NULL
#define OPTION_VAL_PAR_ID NULL
#define OPTION_VAL_4_3_ID NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_ID NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_ID NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_ID NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_ID NULL
#define QUICKNES_PALETTE_LABEL_ID NULL
#define QUICKNES_PALETTE_INFO_0_ID NULL
#define OPTION_VAL_DEFAULT_ID NULL
#define OPTION_VAL_ASQREALC_ID NULL
#define OPTION_VAL_NINTENDO_VC_ID NULL
#define OPTION_VAL_RGB_ID NULL
#define OPTION_VAL_YUV_V3_ID NULL
#define OPTION_VAL_UNSATURATED_FINAL_ID NULL
#define OPTION_VAL_SONY_CXA2025AS_US_ID NULL
#define OPTION_VAL_PAL_ID NULL
#define OPTION_VAL_BMF_FINAL2_ID NULL
#define OPTION_VAL_BMF_FINAL3_ID NULL
#define OPTION_VAL_SMOOTH_FBX_ID NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_ID NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_ID NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_ID NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_ID NULL
#define OPTION_VAL_NESCAP_ID NULL
#define OPTION_VAL_WAVEBEAM_ID NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_ID NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_ID NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_ID NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_ID NULL
#define OPTION_VAL_NONLINEAR_ID NULL
#define OPTION_VAL_LINEAR_ID NULL
#define OPTION_VAL_STEREO_PANNING_ID NULL
#define QUICKNES_AUDIO_EQ_LABEL_ID NULL
#define QUICKNES_AUDIO_EQ_INFO_0_ID NULL
#define OPTION_VAL_FAMICOM_ID NULL
#define OPTION_VAL_TV_ID NULL
#define OPTION_VAL_FLAT_ID NULL
#define OPTION_VAL_CRISP_ID NULL
#define OPTION_VAL_TINNY_ID NULL
#define QUICKNES_TURBO_ENABLE_LABEL_ID NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_ID NULL
#define OPTION_VAL_NONE_ID "Tak ada"
#define OPTION_VAL_PLAYER_1_ID NULL
#define OPTION_VAL_PLAYER_2_ID NULL
#define OPTION_VAL_BOTH_ID NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_ID NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_ID NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_ID NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_ID NULL

struct retro_core_option_v2_category option_cats_id[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_id[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_ID,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_ID,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_ID },
         { "4:3", OPTION_VAL_4_3_ID },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_ID,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_ID,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_ID,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_ID,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_ID,
      NULL,
      QUICKNES_PALETTE_INFO_0_ID,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_ID },
         { "asqrealc",             OPTION_VAL_ASQREALC_ID },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_ID },
         { "rgb",                  OPTION_VAL_RGB_ID },
         { "yuv-v3",               OPTION_VAL_YUV_V3_ID },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_ID },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_ID },
         { "pal",                  OPTION_VAL_PAL_ID },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_ID },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_ID },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_ID },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_ID },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_ID },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_ID },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_ID },
         { "nescap",               OPTION_VAL_NESCAP_ID },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_ID },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_ID,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_ID,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_ID,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_ID,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_ID },
         { "linear",         OPTION_VAL_LINEAR_ID },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_ID },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_ID,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_ID,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_ID },
         { "famicom", OPTION_VAL_FAMICOM_ID },
         { "tv",      OPTION_VAL_TV_ID },
         { "flat",    OPTION_VAL_FLAT_ID },
         { "crisp",   OPTION_VAL_CRISP_ID },
         { "tinny",   OPTION_VAL_TINNY_ID },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_ID,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_ID,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_ID },
         { "player 1", OPTION_VAL_PLAYER_1_ID },
         { "player 2", OPTION_VAL_PLAYER_2_ID },
         { "both",     OPTION_VAL_BOTH_ID },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_ID,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_ID,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_ID,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_ID,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_id = {
   option_cats_id,
   option_defs_id
};

/* RETRO_LANGUAGE_IT */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_IT "Rapporto d'aspetto"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_IT "Questo si applica solo quando le proporzioni di RetroArch's sono impostate su 'fornito dal Core' nelle impostazioni del video."
#define OPTION_VAL_PAR_IT NULL
#define OPTION_VAL_4_3_IT NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_IT "Mostra Overscan Orizzontale"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_IT "Disabilita questo per ritagliare (orizzontalmente) l'uscita video potenzialmente casuale glitchy che sarebbe stato nascosto dalla lunetta intorno al bordo di uno schermo televisivo standard-definizione."
#define QUICKNES_USE_OVERSCAN_V_LABEL_IT "Mostra Overscan Verticale"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_IT "Disabilita questo per ritagliare (verticalmente) l'uscita video potenzialmente casuale glitchy che sarebbe stato nascosto dalla lunetta intorno al bordo di uno schermo televisivo standard-definizione."
#define QUICKNES_PALETTE_LABEL_IT "Tavolozza di Colori"
#define QUICKNES_PALETTE_INFO_0_IT "Specifica quale tavolozza di colori usare durante la decodifica dell'uscita del segnale video NTSC da parte del NES."
#define OPTION_VAL_DEFAULT_IT "Predefinito"
#define OPTION_VAL_ASQREALC_IT "Reale AspiringSquire"
#define OPTION_VAL_NINTENDO_VC_IT "Console Virtuale Nintendo"
#define OPTION_VAL_RGB_IT NULL
#define OPTION_VAL_YUV_V3_IT "YUV-V3 Di FBX"
#define OPTION_VAL_UNSATURATED_FINAL_IT "Finale Insaturo Di FBX"
#define OPTION_VAL_SONY_CXA2025AS_US_IT NULL
#define OPTION_VAL_PAL_IT NULL
#define OPTION_VAL_BMF_FINAL2_IT "Finale 2 Del BMF"
#define OPTION_VAL_BMF_FINAL3_IT "Finale 3 Del BMF"
#define OPTION_VAL_SMOOTH_FBX_IT "Liscio Di FBX"
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_IT "Composito Diretto Di FBX"
#define OPTION_VAL_PVM_STYLE_D93_FBX_IT "Stile Pvm D93 Di FBX"
#define OPTION_VAL_NTSC_HARDWARE_FBX_IT "Hardware NTSC Di FBX"
#define OPTION_VAL_NES_CLASSIC_FBX_FS_IT "NES-Classic Di FBX (Fisso)"
#define OPTION_VAL_NESCAP_IT "NESCAP di RGBSource"
#define OPTION_VAL_WAVEBEAM_IT "wavebeam di nakedarthur"
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_IT "Nessun Limite Sprite"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_IT "Rimuove il limite hardware 8-sprite-per-scanline. Questo riduce lo sfarfallio ma può causare problemi visivi, poiché alcuni giochi sfruttano il limite hardware per generare effetti speciali."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_IT "Modalità Audio"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_IT "Configura l'emulazione audio. 'Non Lineare' simula il mixaggio non lineare del canale dell'APU NES. 'Linear' utilizza un'approssimazione meno accurata, che riduce la qualità ma aumenta le prestazioni su hardware di fascia bassa. 'Stereo Panning' aggiunge profondità all'output di NES mono attraverso l'uso di tecniche di panning e effetti di riverbero."
#define OPTION_VAL_NONLINEAR_IT "Non-Lineare"
#define OPTION_VAL_LINEAR_IT "Lineare"
#define OPTION_VAL_STEREO_PANNING_IT NULL
#define QUICKNES_AUDIO_EQ_LABEL_IT "Preimpostazione Equalizzatore Audio"
#define QUICKNES_AUDIO_EQ_INFO_0_IT "Regola l'equilibrio tra i componenti di frequenza audio con un preimpostazione equalizzatore personalizzato."
#define OPTION_VAL_FAMICOM_IT NULL
#define OPTION_VAL_TV_IT NULL
#define OPTION_VAL_FLAT_IT "Piatto"
#define OPTION_VAL_CRISP_IT "Nitido"
#define OPTION_VAL_TINNY_IT "Metallico"
#define QUICKNES_TURBO_ENABLE_LABEL_IT "Attiva Turbo"
#define QUICKNES_TURBO_ENABLE_INFO_0_IT "Abilita l'uso dei pulsanti Turbo A e Turbo B."
#define OPTION_VAL_NONE_IT "Nessuno"
#define OPTION_VAL_PLAYER_1_IT "Giocatore 1"
#define OPTION_VAL_PLAYER_2_IT "Giocatore 2"
#define OPTION_VAL_BOTH_IT "Giocatore 1 & 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_IT "Larghezza Pulse Turbo (in fotogrammi)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_IT "Specifica sia la larghezza che la spaziatura (in fotogrammi) degli impulsi di ingresso quando i pulsanti Turbo A e Turbo B vengono mantenuti. Per esempio, l'impostazione predefinita di '3' corrisponde a una frequenza turbo (60/(3+3)) = 10 Hz (10 pressioni al secondo)."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_IT "Permetti Direzioni Opposte"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_IT "Abilitando questa opzione sarà possibile premere / alternare rapidamente / tenere contemporaneamente sia le direzioni sinistra che destra (o su e giù). Ciò può causare problemi di movimento."

struct retro_core_option_v2_category option_cats_it[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_it[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_IT,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_IT,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_IT },
         { "4:3", OPTION_VAL_4_3_IT },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_IT,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_IT,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_IT,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_IT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_IT,
      NULL,
      QUICKNES_PALETTE_INFO_0_IT,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_IT },
         { "asqrealc",             OPTION_VAL_ASQREALC_IT },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_IT },
         { "rgb",                  OPTION_VAL_RGB_IT },
         { "yuv-v3",               OPTION_VAL_YUV_V3_IT },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_IT },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_IT },
         { "pal",                  OPTION_VAL_PAL_IT },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_IT },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_IT },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_IT },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_IT },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_IT },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_IT },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_IT },
         { "nescap",               OPTION_VAL_NESCAP_IT },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_IT },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_IT,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_IT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_IT,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_IT,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_IT },
         { "linear",         OPTION_VAL_LINEAR_IT },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_IT },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_IT,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_IT,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_IT },
         { "famicom", OPTION_VAL_FAMICOM_IT },
         { "tv",      OPTION_VAL_TV_IT },
         { "flat",    OPTION_VAL_FLAT_IT },
         { "crisp",   OPTION_VAL_CRISP_IT },
         { "tinny",   OPTION_VAL_TINNY_IT },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_IT,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_IT,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_IT },
         { "player 1", OPTION_VAL_PLAYER_1_IT },
         { "player 2", OPTION_VAL_PLAYER_2_IT },
         { "both",     OPTION_VAL_BOTH_IT },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_IT,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_IT,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_IT,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_IT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_it = {
   option_cats_it,
   option_defs_it
};

/* RETRO_LANGUAGE_JA */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_JA "アスペクト比"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_JA NULL
#define OPTION_VAL_PAR_JA NULL
#define OPTION_VAL_4_3_JA NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_JA NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_JA NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_JA NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_JA NULL
#define QUICKNES_PALETTE_LABEL_JA "カラーパレット"
#define QUICKNES_PALETTE_INFO_0_JA NULL
#define OPTION_VAL_DEFAULT_JA "デフォルト"
#define OPTION_VAL_ASQREALC_JA NULL
#define OPTION_VAL_NINTENDO_VC_JA NULL
#define OPTION_VAL_RGB_JA NULL
#define OPTION_VAL_YUV_V3_JA NULL
#define OPTION_VAL_UNSATURATED_FINAL_JA NULL
#define OPTION_VAL_SONY_CXA2025AS_US_JA NULL
#define OPTION_VAL_PAL_JA NULL
#define OPTION_VAL_BMF_FINAL2_JA NULL
#define OPTION_VAL_BMF_FINAL3_JA NULL
#define OPTION_VAL_SMOOTH_FBX_JA NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_JA NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_JA NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_JA NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_JA NULL
#define OPTION_VAL_NESCAP_JA NULL
#define OPTION_VAL_WAVEBEAM_JA NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_JA NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_JA NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_JA NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_JA NULL
#define OPTION_VAL_NONLINEAR_JA NULL
#define OPTION_VAL_LINEAR_JA "リニア"
#define OPTION_VAL_STEREO_PANNING_JA NULL
#define QUICKNES_AUDIO_EQ_LABEL_JA NULL
#define QUICKNES_AUDIO_EQ_INFO_0_JA NULL
#define OPTION_VAL_FAMICOM_JA NULL
#define OPTION_VAL_TV_JA NULL
#define OPTION_VAL_FLAT_JA NULL
#define OPTION_VAL_CRISP_JA NULL
#define OPTION_VAL_TINNY_JA NULL
#define QUICKNES_TURBO_ENABLE_LABEL_JA NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_JA NULL
#define OPTION_VAL_NONE_JA "なし"
#define OPTION_VAL_PLAYER_1_JA NULL
#define OPTION_VAL_PLAYER_2_JA NULL
#define OPTION_VAL_BOTH_JA NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_JA NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_JA NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_JA NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_JA "有効にすると、左右 (または上下) 方向の同時押し / 高速交互押し / 長押しが可能になります。動作に不具合が生じる場合があります。"

struct retro_core_option_v2_category option_cats_ja[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_ja[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_JA,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_JA,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_JA },
         { "4:3", OPTION_VAL_4_3_JA },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_JA,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_JA,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_JA,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_JA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_JA,
      NULL,
      QUICKNES_PALETTE_INFO_0_JA,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_JA },
         { "asqrealc",             OPTION_VAL_ASQREALC_JA },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_JA },
         { "rgb",                  OPTION_VAL_RGB_JA },
         { "yuv-v3",               OPTION_VAL_YUV_V3_JA },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_JA },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_JA },
         { "pal",                  OPTION_VAL_PAL_JA },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_JA },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_JA },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_JA },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_JA },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_JA },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_JA },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_JA },
         { "nescap",               OPTION_VAL_NESCAP_JA },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_JA },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_JA,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_JA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_JA,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_JA,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_JA },
         { "linear",         OPTION_VAL_LINEAR_JA },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_JA },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_JA,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_JA,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_JA },
         { "famicom", OPTION_VAL_FAMICOM_JA },
         { "tv",      OPTION_VAL_TV_JA },
         { "flat",    OPTION_VAL_FLAT_JA },
         { "crisp",   OPTION_VAL_CRISP_JA },
         { "tinny",   OPTION_VAL_TINNY_JA },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_JA,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_JA,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_JA },
         { "player 1", OPTION_VAL_PLAYER_1_JA },
         { "player 2", OPTION_VAL_PLAYER_2_JA },
         { "both",     OPTION_VAL_BOTH_JA },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_JA,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_JA,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_JA,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_JA,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_ja = {
   option_cats_ja,
   option_defs_ja
};

/* RETRO_LANGUAGE_KO */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_KO "화면비"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_KO "RetroArch의 비디오 설정에서 화면비가 '코어에 따름'으로 설정되어 있어야 적용됩니다."
#define OPTION_VAL_PAR_KO NULL
#define OPTION_VAL_4_3_KO NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_KO "가로 오버스캔 표시하기"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_KO "이 옵션을 비활성화하면 일반적인 TV 화면에서 테두리 베젤에 의해 가려지는 비디오 출력의 이상한 부분(가로)을 표시합니다."
#define QUICKNES_USE_OVERSCAN_V_LABEL_KO "세로 오버스캔 표시하기"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_KO "이 옵션을 비활성화하면 일반적인 TV 화면에서 테두리 베젤에 의해 가려지는 비디오 출력의 이상한 부분(세로)을 표시합니다."
#define QUICKNES_PALETTE_LABEL_KO "색상 팔레트"
#define QUICKNES_PALETTE_INFO_0_KO "NES가 출력하는 NTSC 비디오 신호를 디코딩할 때 사용할 색상 팔레트를 선택합니다."
#define OPTION_VAL_DEFAULT_KO "기본"
#define OPTION_VAL_ASQREALC_KO NULL
#define OPTION_VAL_NINTENDO_VC_KO NULL
#define OPTION_VAL_RGB_KO NULL
#define OPTION_VAL_YUV_V3_KO NULL
#define OPTION_VAL_UNSATURATED_FINAL_KO NULL
#define OPTION_VAL_SONY_CXA2025AS_US_KO NULL
#define OPTION_VAL_PAL_KO NULL
#define OPTION_VAL_BMF_FINAL2_KO NULL
#define OPTION_VAL_BMF_FINAL3_KO NULL
#define OPTION_VAL_SMOOTH_FBX_KO NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_KO NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_KO NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_KO NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_KO "FBX's NES-Classic (개선판)"
#define OPTION_VAL_NESCAP_KO NULL
#define OPTION_VAL_WAVEBEAM_KO NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_KO "스프라이트 제한 해제"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_KO "원본 하드웨어에 존재하는 스캔라인 당 스프라이트 제한을 제거합니다. 깜빡임을 줄여주지만 이러한 제한을 활용해 특별한 효과를 만들어내는 게임에서는 그래픽 오류가 일어날 수 있습니다."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_KO "오디오 모드"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_KO "오디오 에뮬레이션을 설정합니다. '비선형'은 NES APU의 비선형적 채널 믹싱을 흉내냅니다. '선형'은 부정확한 근사치를 사용하여 품질은 떨어지지만 저사양 하드웨어에서 성능이 향상됩니다. '스테레오 패닝'은 NES의 모노 오디오에 패닝과 리버브 효과를 적용하여 깊이를 추가합니다."
#define OPTION_VAL_NONLINEAR_KO "비선형"
#define OPTION_VAL_LINEAR_KO "선형"
#define OPTION_VAL_STEREO_PANNING_KO "스테레오 패닝"
#define QUICKNES_AUDIO_EQ_LABEL_KO "오디오 이퀄라이저 프리셋"
#define QUICKNES_AUDIO_EQ_INFO_0_KO "사용자 정의 이퀄라이저 프리셋을 사용하여 오디오 주파수 요소 간 밸런스를 조정합니다."
#define OPTION_VAL_FAMICOM_KO "패미컴"
#define OPTION_VAL_TV_KO NULL
#define OPTION_VAL_FLAT_KO "플랫"
#define OPTION_VAL_CRISP_KO "선명하게"
#define OPTION_VAL_TINNY_KO "깡통 속"
#define QUICKNES_TURBO_ENABLE_LABEL_KO "터보 사용"
#define QUICKNES_TURBO_ENABLE_INFO_0_KO "터보 A와 터보 B 버튼을 사용할 수 있게 합니다."
#define OPTION_VAL_NONE_KO "없음"
#define OPTION_VAL_PLAYER_1_KO "플레이어 1"
#define OPTION_VAL_PLAYER_2_KO "플레이어 2"
#define OPTION_VAL_BOTH_KO "플레이어 1 & 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_KO "터보 펄스 길이 (프레임)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_KO "터보 A와 터보 B 버튼을 꾹 누를 때 사용할 입력 '펄스'의 길이와 간격(프레임)을 설정합니다. 예를 들어, 기본 설정인 '3'은 터보 간격을 (60/(3+3)) = 10 Hz(초당 10회 입력)로 설정합니다."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_KO "반대 방향 동시 입력 허용"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_KO "이 옵션을 활성화하면 왼쪽과 오른쪽 (또는 위쪽과 아래쪽) 방향 입력을 동시에 누르거나 빠르게 번갈아 누르는 것을 허용합니다. 이는 움직임 관련 버그를 일으킬 수 있습니다."

struct retro_core_option_v2_category option_cats_ko[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_ko[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_KO,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_KO,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_KO },
         { "4:3", OPTION_VAL_4_3_KO },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_KO,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_KO,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_KO,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_KO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_KO,
      NULL,
      QUICKNES_PALETTE_INFO_0_KO,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_KO },
         { "asqrealc",             OPTION_VAL_ASQREALC_KO },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_KO },
         { "rgb",                  OPTION_VAL_RGB_KO },
         { "yuv-v3",               OPTION_VAL_YUV_V3_KO },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_KO },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_KO },
         { "pal",                  OPTION_VAL_PAL_KO },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_KO },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_KO },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_KO },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_KO },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_KO },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_KO },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_KO },
         { "nescap",               OPTION_VAL_NESCAP_KO },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_KO },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_KO,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_KO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_KO,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_KO,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_KO },
         { "linear",         OPTION_VAL_LINEAR_KO },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_KO },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_KO,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_KO,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_KO },
         { "famicom", OPTION_VAL_FAMICOM_KO },
         { "tv",      OPTION_VAL_TV_KO },
         { "flat",    OPTION_VAL_FLAT_KO },
         { "crisp",   OPTION_VAL_CRISP_KO },
         { "tinny",   OPTION_VAL_TINNY_KO },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_KO,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_KO,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_KO },
         { "player 1", OPTION_VAL_PLAYER_1_KO },
         { "player 2", OPTION_VAL_PLAYER_2_KO },
         { "both",     OPTION_VAL_BOTH_KO },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_KO,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_KO,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_KO,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_KO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_ko = {
   option_cats_ko,
   option_defs_ko
};

/* RETRO_LANGUAGE_MT */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_MT NULL
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_MT NULL
#define OPTION_VAL_PAR_MT NULL
#define OPTION_VAL_4_3_MT NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_MT NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_MT NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_MT NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_MT NULL
#define QUICKNES_PALETTE_LABEL_MT NULL
#define QUICKNES_PALETTE_INFO_0_MT NULL
#define OPTION_VAL_DEFAULT_MT NULL
#define OPTION_VAL_ASQREALC_MT NULL
#define OPTION_VAL_NINTENDO_VC_MT NULL
#define OPTION_VAL_RGB_MT NULL
#define OPTION_VAL_YUV_V3_MT NULL
#define OPTION_VAL_UNSATURATED_FINAL_MT NULL
#define OPTION_VAL_SONY_CXA2025AS_US_MT NULL
#define OPTION_VAL_PAL_MT NULL
#define OPTION_VAL_BMF_FINAL2_MT NULL
#define OPTION_VAL_BMF_FINAL3_MT NULL
#define OPTION_VAL_SMOOTH_FBX_MT NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_MT NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_MT NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_MT NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_MT NULL
#define OPTION_VAL_NESCAP_MT NULL
#define OPTION_VAL_WAVEBEAM_MT NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_MT NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_MT NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_MT NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_MT NULL
#define OPTION_VAL_NONLINEAR_MT NULL
#define OPTION_VAL_LINEAR_MT NULL
#define OPTION_VAL_STEREO_PANNING_MT NULL
#define QUICKNES_AUDIO_EQ_LABEL_MT NULL
#define QUICKNES_AUDIO_EQ_INFO_0_MT NULL
#define OPTION_VAL_FAMICOM_MT NULL
#define OPTION_VAL_TV_MT NULL
#define OPTION_VAL_FLAT_MT NULL
#define OPTION_VAL_CRISP_MT NULL
#define OPTION_VAL_TINNY_MT NULL
#define QUICKNES_TURBO_ENABLE_LABEL_MT NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_MT NULL
#define OPTION_VAL_NONE_MT NULL
#define OPTION_VAL_PLAYER_1_MT NULL
#define OPTION_VAL_PLAYER_2_MT NULL
#define OPTION_VAL_BOTH_MT NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_MT NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_MT NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_MT NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_MT NULL

struct retro_core_option_v2_category option_cats_mt[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_mt[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_MT,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_MT,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_MT },
         { "4:3", OPTION_VAL_4_3_MT },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_MT,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_MT,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_MT,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_MT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_MT,
      NULL,
      QUICKNES_PALETTE_INFO_0_MT,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_MT },
         { "asqrealc",             OPTION_VAL_ASQREALC_MT },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_MT },
         { "rgb",                  OPTION_VAL_RGB_MT },
         { "yuv-v3",               OPTION_VAL_YUV_V3_MT },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_MT },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_MT },
         { "pal",                  OPTION_VAL_PAL_MT },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_MT },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_MT },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_MT },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_MT },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_MT },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_MT },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_MT },
         { "nescap",               OPTION_VAL_NESCAP_MT },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_MT },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_MT,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_MT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_MT,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_MT,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_MT },
         { "linear",         OPTION_VAL_LINEAR_MT },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_MT },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_MT,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_MT,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_MT },
         { "famicom", OPTION_VAL_FAMICOM_MT },
         { "tv",      OPTION_VAL_TV_MT },
         { "flat",    OPTION_VAL_FLAT_MT },
         { "crisp",   OPTION_VAL_CRISP_MT },
         { "tinny",   OPTION_VAL_TINNY_MT },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_MT,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_MT,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_MT },
         { "player 1", OPTION_VAL_PLAYER_1_MT },
         { "player 2", OPTION_VAL_PLAYER_2_MT },
         { "both",     OPTION_VAL_BOTH_MT },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_MT,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_MT,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_MT,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_MT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_mt = {
   option_cats_mt,
   option_defs_mt
};

/* RETRO_LANGUAGE_NL */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_NL "Beeldverhouding"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_NL NULL
#define OPTION_VAL_PAR_NL NULL
#define OPTION_VAL_4_3_NL NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_NL NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_NL NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_NL NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_NL NULL
#define QUICKNES_PALETTE_LABEL_NL NULL
#define QUICKNES_PALETTE_INFO_0_NL NULL
#define OPTION_VAL_DEFAULT_NL NULL
#define OPTION_VAL_ASQREALC_NL NULL
#define OPTION_VAL_NINTENDO_VC_NL NULL
#define OPTION_VAL_RGB_NL NULL
#define OPTION_VAL_YUV_V3_NL NULL
#define OPTION_VAL_UNSATURATED_FINAL_NL NULL
#define OPTION_VAL_SONY_CXA2025AS_US_NL NULL
#define OPTION_VAL_PAL_NL NULL
#define OPTION_VAL_BMF_FINAL2_NL NULL
#define OPTION_VAL_BMF_FINAL3_NL NULL
#define OPTION_VAL_SMOOTH_FBX_NL NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_NL NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_NL NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_NL NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_NL NULL
#define OPTION_VAL_NESCAP_NL NULL
#define OPTION_VAL_WAVEBEAM_NL NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_NL NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_NL NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_NL NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_NL NULL
#define OPTION_VAL_NONLINEAR_NL NULL
#define OPTION_VAL_LINEAR_NL "Lineair"
#define OPTION_VAL_STEREO_PANNING_NL NULL
#define QUICKNES_AUDIO_EQ_LABEL_NL NULL
#define QUICKNES_AUDIO_EQ_INFO_0_NL NULL
#define OPTION_VAL_FAMICOM_NL NULL
#define OPTION_VAL_TV_NL NULL
#define OPTION_VAL_FLAT_NL NULL
#define OPTION_VAL_CRISP_NL NULL
#define OPTION_VAL_TINNY_NL NULL
#define QUICKNES_TURBO_ENABLE_LABEL_NL NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_NL NULL
#define OPTION_VAL_NONE_NL "Geen"
#define OPTION_VAL_PLAYER_1_NL NULL
#define OPTION_VAL_PLAYER_2_NL NULL
#define OPTION_VAL_BOTH_NL NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_NL NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_NL NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_NL NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_NL NULL

struct retro_core_option_v2_category option_cats_nl[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_nl[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_NL,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_NL,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_NL },
         { "4:3", OPTION_VAL_4_3_NL },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_NL,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_NL,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_NL,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_NL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_NL,
      NULL,
      QUICKNES_PALETTE_INFO_0_NL,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_NL },
         { "asqrealc",             OPTION_VAL_ASQREALC_NL },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_NL },
         { "rgb",                  OPTION_VAL_RGB_NL },
         { "yuv-v3",               OPTION_VAL_YUV_V3_NL },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_NL },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_NL },
         { "pal",                  OPTION_VAL_PAL_NL },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_NL },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_NL },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_NL },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_NL },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_NL },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_NL },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_NL },
         { "nescap",               OPTION_VAL_NESCAP_NL },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_NL },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_NL,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_NL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_NL,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_NL,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_NL },
         { "linear",         OPTION_VAL_LINEAR_NL },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_NL },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_NL,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_NL,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_NL },
         { "famicom", OPTION_VAL_FAMICOM_NL },
         { "tv",      OPTION_VAL_TV_NL },
         { "flat",    OPTION_VAL_FLAT_NL },
         { "crisp",   OPTION_VAL_CRISP_NL },
         { "tinny",   OPTION_VAL_TINNY_NL },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_NL,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_NL,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_NL },
         { "player 1", OPTION_VAL_PLAYER_1_NL },
         { "player 2", OPTION_VAL_PLAYER_2_NL },
         { "both",     OPTION_VAL_BOTH_NL },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_NL,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_NL,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_NL,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_NL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_nl = {
   option_cats_nl,
   option_defs_nl
};

/* RETRO_LANGUAGE_NO */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_NO "Størrelsesforhold"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_NO NULL
#define OPTION_VAL_PAR_NO NULL
#define OPTION_VAL_4_3_NO NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_NO NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_NO NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_NO NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_NO NULL
#define QUICKNES_PALETTE_LABEL_NO NULL
#define QUICKNES_PALETTE_INFO_0_NO NULL
#define OPTION_VAL_DEFAULT_NO NULL
#define OPTION_VAL_ASQREALC_NO NULL
#define OPTION_VAL_NINTENDO_VC_NO NULL
#define OPTION_VAL_RGB_NO NULL
#define OPTION_VAL_YUV_V3_NO NULL
#define OPTION_VAL_UNSATURATED_FINAL_NO NULL
#define OPTION_VAL_SONY_CXA2025AS_US_NO NULL
#define OPTION_VAL_PAL_NO NULL
#define OPTION_VAL_BMF_FINAL2_NO NULL
#define OPTION_VAL_BMF_FINAL3_NO NULL
#define OPTION_VAL_SMOOTH_FBX_NO NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_NO NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_NO NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_NO NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_NO NULL
#define OPTION_VAL_NESCAP_NO NULL
#define OPTION_VAL_WAVEBEAM_NO NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_NO NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_NO NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_NO NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_NO NULL
#define OPTION_VAL_NONLINEAR_NO NULL
#define OPTION_VAL_LINEAR_NO NULL
#define OPTION_VAL_STEREO_PANNING_NO NULL
#define QUICKNES_AUDIO_EQ_LABEL_NO NULL
#define QUICKNES_AUDIO_EQ_INFO_0_NO NULL
#define OPTION_VAL_FAMICOM_NO NULL
#define OPTION_VAL_TV_NO NULL
#define OPTION_VAL_FLAT_NO NULL
#define OPTION_VAL_CRISP_NO NULL
#define OPTION_VAL_TINNY_NO NULL
#define QUICKNES_TURBO_ENABLE_LABEL_NO NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_NO NULL
#define OPTION_VAL_NONE_NO "Ingen"
#define OPTION_VAL_PLAYER_1_NO NULL
#define OPTION_VAL_PLAYER_2_NO NULL
#define OPTION_VAL_BOTH_NO NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_NO NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_NO NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_NO NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_NO NULL

struct retro_core_option_v2_category option_cats_no[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_no[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_NO,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_NO,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_NO },
         { "4:3", OPTION_VAL_4_3_NO },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_NO,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_NO,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_NO,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_NO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_NO,
      NULL,
      QUICKNES_PALETTE_INFO_0_NO,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_NO },
         { "asqrealc",             OPTION_VAL_ASQREALC_NO },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_NO },
         { "rgb",                  OPTION_VAL_RGB_NO },
         { "yuv-v3",               OPTION_VAL_YUV_V3_NO },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_NO },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_NO },
         { "pal",                  OPTION_VAL_PAL_NO },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_NO },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_NO },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_NO },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_NO },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_NO },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_NO },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_NO },
         { "nescap",               OPTION_VAL_NESCAP_NO },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_NO },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_NO,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_NO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_NO,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_NO,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_NO },
         { "linear",         OPTION_VAL_LINEAR_NO },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_NO },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_NO,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_NO,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_NO },
         { "famicom", OPTION_VAL_FAMICOM_NO },
         { "tv",      OPTION_VAL_TV_NO },
         { "flat",    OPTION_VAL_FLAT_NO },
         { "crisp",   OPTION_VAL_CRISP_NO },
         { "tinny",   OPTION_VAL_TINNY_NO },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_NO,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_NO,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_NO },
         { "player 1", OPTION_VAL_PLAYER_1_NO },
         { "player 2", OPTION_VAL_PLAYER_2_NO },
         { "both",     OPTION_VAL_BOTH_NO },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_NO,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_NO,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_NO,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_NO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_no = {
   option_cats_no,
   option_defs_no
};

/* RETRO_LANGUAGE_OC */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_OC NULL
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_OC NULL
#define OPTION_VAL_PAR_OC NULL
#define OPTION_VAL_4_3_OC NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_OC NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_OC NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_OC NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_OC NULL
#define QUICKNES_PALETTE_LABEL_OC NULL
#define QUICKNES_PALETTE_INFO_0_OC NULL
#define OPTION_VAL_DEFAULT_OC NULL
#define OPTION_VAL_ASQREALC_OC NULL
#define OPTION_VAL_NINTENDO_VC_OC NULL
#define OPTION_VAL_RGB_OC NULL
#define OPTION_VAL_YUV_V3_OC NULL
#define OPTION_VAL_UNSATURATED_FINAL_OC NULL
#define OPTION_VAL_SONY_CXA2025AS_US_OC NULL
#define OPTION_VAL_PAL_OC NULL
#define OPTION_VAL_BMF_FINAL2_OC NULL
#define OPTION_VAL_BMF_FINAL3_OC NULL
#define OPTION_VAL_SMOOTH_FBX_OC NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_OC NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_OC NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_OC NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_OC NULL
#define OPTION_VAL_NESCAP_OC NULL
#define OPTION_VAL_WAVEBEAM_OC NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_OC NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_OC NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_OC NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_OC NULL
#define OPTION_VAL_NONLINEAR_OC NULL
#define OPTION_VAL_LINEAR_OC NULL
#define OPTION_VAL_STEREO_PANNING_OC NULL
#define QUICKNES_AUDIO_EQ_LABEL_OC NULL
#define QUICKNES_AUDIO_EQ_INFO_0_OC NULL
#define OPTION_VAL_FAMICOM_OC NULL
#define OPTION_VAL_TV_OC NULL
#define OPTION_VAL_FLAT_OC NULL
#define OPTION_VAL_CRISP_OC NULL
#define OPTION_VAL_TINNY_OC NULL
#define QUICKNES_TURBO_ENABLE_LABEL_OC NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_OC NULL
#define OPTION_VAL_NONE_OC NULL
#define OPTION_VAL_PLAYER_1_OC NULL
#define OPTION_VAL_PLAYER_2_OC NULL
#define OPTION_VAL_BOTH_OC NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_OC NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_OC NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_OC NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_OC NULL

struct retro_core_option_v2_category option_cats_oc[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_oc[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_OC,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_OC,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_OC },
         { "4:3", OPTION_VAL_4_3_OC },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_OC,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_OC,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_OC,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_OC,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_OC,
      NULL,
      QUICKNES_PALETTE_INFO_0_OC,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_OC },
         { "asqrealc",             OPTION_VAL_ASQREALC_OC },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_OC },
         { "rgb",                  OPTION_VAL_RGB_OC },
         { "yuv-v3",               OPTION_VAL_YUV_V3_OC },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_OC },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_OC },
         { "pal",                  OPTION_VAL_PAL_OC },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_OC },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_OC },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_OC },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_OC },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_OC },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_OC },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_OC },
         { "nescap",               OPTION_VAL_NESCAP_OC },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_OC },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_OC,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_OC,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_OC,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_OC,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_OC },
         { "linear",         OPTION_VAL_LINEAR_OC },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_OC },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_OC,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_OC,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_OC },
         { "famicom", OPTION_VAL_FAMICOM_OC },
         { "tv",      OPTION_VAL_TV_OC },
         { "flat",    OPTION_VAL_FLAT_OC },
         { "crisp",   OPTION_VAL_CRISP_OC },
         { "tinny",   OPTION_VAL_TINNY_OC },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_OC,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_OC,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_OC },
         { "player 1", OPTION_VAL_PLAYER_1_OC },
         { "player 2", OPTION_VAL_PLAYER_2_OC },
         { "both",     OPTION_VAL_BOTH_OC },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_OC,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_OC,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_OC,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_OC,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_oc = {
   option_cats_oc,
   option_defs_oc
};

/* RETRO_LANGUAGE_PL */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_PL "Współczynnik proporcji"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_PL NULL
#define OPTION_VAL_PAR_PL NULL
#define OPTION_VAL_4_3_PL NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_PL NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_PL NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_PL "Pokaż pionowy overscan"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_PL NULL
#define QUICKNES_PALETTE_LABEL_PL "Paleta kolorów"
#define QUICKNES_PALETTE_INFO_0_PL NULL
#define OPTION_VAL_DEFAULT_PL "Domyślny"
#define OPTION_VAL_ASQREALC_PL NULL
#define OPTION_VAL_NINTENDO_VC_PL "Konsola wirtualna Nintendo"
#define OPTION_VAL_RGB_PL NULL
#define OPTION_VAL_YUV_V3_PL "FBX YUV-V3"
#define OPTION_VAL_UNSATURATED_FINAL_PL NULL
#define OPTION_VAL_SONY_CXA2025AS_US_PL "Sony CXA2025AS USA"
#define OPTION_VAL_PAL_PL NULL
#define OPTION_VAL_BMF_FINAL2_PL NULL
#define OPTION_VAL_BMF_FINAL3_PL NULL
#define OPTION_VAL_SMOOTH_FBX_PL NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_PL NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_PL NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_PL NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_PL "FBX NES-Classic (naprawiony)"
#define OPTION_VAL_NESCAP_PL NULL
#define OPTION_VAL_WAVEBEAM_PL NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_PL "Bez limitu duszków"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_PL NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_PL NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_PL NULL
#define OPTION_VAL_NONLINEAR_PL "Nie liniowy"
#define OPTION_VAL_LINEAR_PL "Liniowy"
#define OPTION_VAL_STEREO_PANNING_PL NULL
#define QUICKNES_AUDIO_EQ_LABEL_PL NULL
#define QUICKNES_AUDIO_EQ_INFO_0_PL NULL
#define OPTION_VAL_FAMICOM_PL NULL
#define OPTION_VAL_TV_PL NULL
#define OPTION_VAL_FLAT_PL NULL
#define OPTION_VAL_CRISP_PL NULL
#define OPTION_VAL_TINNY_PL NULL
#define QUICKNES_TURBO_ENABLE_LABEL_PL "Włącz turbo"
#define QUICKNES_TURBO_ENABLE_INFO_0_PL NULL
#define OPTION_VAL_NONE_PL "Brak"
#define OPTION_VAL_PLAYER_1_PL "Gracz nr. 1"
#define OPTION_VAL_PLAYER_2_PL "Gracz nr. 2"
#define OPTION_VAL_BOTH_PL "Gracz nr. 1 i 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_PL NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_PL NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_PL "Zezwalaj na przeciwne kierunki"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_PL NULL

struct retro_core_option_v2_category option_cats_pl[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_pl[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_PL,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_PL,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_PL },
         { "4:3", OPTION_VAL_4_3_PL },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_PL,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_PL,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_PL,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_PL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_PL,
      NULL,
      QUICKNES_PALETTE_INFO_0_PL,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_PL },
         { "asqrealc",             OPTION_VAL_ASQREALC_PL },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_PL },
         { "rgb",                  OPTION_VAL_RGB_PL },
         { "yuv-v3",               OPTION_VAL_YUV_V3_PL },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_PL },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_PL },
         { "pal",                  OPTION_VAL_PAL_PL },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_PL },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_PL },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_PL },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_PL },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_PL },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_PL },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_PL },
         { "nescap",               OPTION_VAL_NESCAP_PL },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_PL },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_PL,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_PL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_PL,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_PL,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_PL },
         { "linear",         OPTION_VAL_LINEAR_PL },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_PL },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_PL,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_PL,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_PL },
         { "famicom", OPTION_VAL_FAMICOM_PL },
         { "tv",      OPTION_VAL_TV_PL },
         { "flat",    OPTION_VAL_FLAT_PL },
         { "crisp",   OPTION_VAL_CRISP_PL },
         { "tinny",   OPTION_VAL_TINNY_PL },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_PL,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_PL,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_PL },
         { "player 1", OPTION_VAL_PLAYER_1_PL },
         { "player 2", OPTION_VAL_PLAYER_2_PL },
         { "both",     OPTION_VAL_BOTH_PL },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_PL,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_PL,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_PL,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_PL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_pl = {
   option_cats_pl,
   option_defs_pl
};

/* RETRO_LANGUAGE_PT_BR */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_PT_BR "Proporção de tela"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_PT_BR "Isto só se aplicará quando a proporção de tela do RetroarArch estiver definida como 'Fornecida pelo núcleo' nas configurações de vídeo."
#define OPTION_VAL_PAR_PT_BR "PAR (Relação de aspecto do pixel)"
#define OPTION_VAL_4_3_PT_BR NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_PT_BR "Mostrar overscan horizontal"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_PT_BR "Desabilite esta opção para cortar (a parte horizontal) dos possíveis defeitos visuais aleatórios no vídeo que normalmente seriam escondidos pelo enquadramento de uma televisão de definição padrão."
#define QUICKNES_USE_OVERSCAN_V_LABEL_PT_BR "Mostrar overscan vertical"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_PT_BR "Desabilite esta opção para cortar (a parte vertical) dos possíveis defeitos visuais aleatórios no vídeo que normalmente seriam escondidos pelo enquadramento de uma televisão de definição padrão."
#define QUICKNES_PALETTE_LABEL_PT_BR "Paleta de cores"
#define QUICKNES_PALETTE_INFO_0_PT_BR "Especifica qual paleta de cores será usada ao decodificar o sinal de vídeo NTSC pelo NES."
#define OPTION_VAL_DEFAULT_PT_BR "Padrão"
#define OPTION_VAL_ASQREALC_PT_BR "Real de AspiringSquire"
#define OPTION_VAL_NINTENDO_VC_PT_BR NULL
#define OPTION_VAL_RGB_PT_BR "PPU RGB do Nintendo"
#define OPTION_VAL_YUV_V3_PT_BR "YUV-V3 de FBX"
#define OPTION_VAL_UNSATURATED_FINAL_PT_BR "Final sem saturação de FBX"
#define OPTION_VAL_SONY_CXA2025AS_US_PT_BR "Sony CXA2025AS dos EUA"
#define OPTION_VAL_PAL_PT_BR NULL
#define OPTION_VAL_BMF_FINAL2_PT_BR "Final 2 de BMF"
#define OPTION_VAL_BMF_FINAL3_PT_BR "Final 3 de BMF"
#define OPTION_VAL_SMOOTH_FBX_PT_BR "Suavização de FBX"
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_PT_BR "Sinal direto de vídeo composto de FBX"
#define OPTION_VAL_PVM_STYLE_D93_FBX_PT_BR "PVM estilo D93 de FBX"
#define OPTION_VAL_NTSC_HARDWARE_FBX_PT_BR "Hardware NTSC de FBX"
#define OPTION_VAL_NES_CLASSIC_FBX_FS_PT_BR "NES-Classic do FBX (corrigido)"
#define OPTION_VAL_NESCAP_PT_BR "NESCAP de RGBSource"
#define OPTION_VAL_WAVEBEAM_PT_BR "Wavebeam de nakedarthur"
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_PT_BR "Sem limite de sprite"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_PT_BR "Remove o limite de 8 sprites por linha de varredura que o hardware original tinha. Reduz a tremulação, mas pode causar falhas gráficas, já que alguns jogos aproveitam esta limitação para gerar efeitos especiais."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_PT_BR "Modo de áudio"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_PT_BR "Configura a emulação de áudio. 'Não linear' simula a mistura não linear de canais da APU do NES. 'Linear' usa uma aproximação menos precisa, o que reduz a qualidade, mas aumenta o desempenho em hardware de baixo custo. 'Balanço do estéreo' aumenta a profundidade de saída do mono do NES através do uso de técnicas de balanço e efeitos de reverberação."
#define OPTION_VAL_NONLINEAR_PT_BR "Não linear"
#define OPTION_VAL_LINEAR_PT_BR NULL
#define OPTION_VAL_STEREO_PANNING_PT_BR "Balanço do estéreo"
#define QUICKNES_AUDIO_EQ_LABEL_PT_BR "Predefinição do equalizador de áudio"
#define QUICKNES_AUDIO_EQ_INFO_0_PT_BR "Ajuste o equilíbrio entre os componentes de frequência de áudio com uma predefinição personalizada do equalizador."
#define OPTION_VAL_FAMICOM_PT_BR NULL
#define OPTION_VAL_TV_PT_BR NULL
#define OPTION_VAL_FLAT_PT_BR "Puro"
#define OPTION_VAL_CRISP_PT_BR "Nítido"
#define OPTION_VAL_TINNY_PT_BR "Metálico"
#define QUICKNES_TURBO_ENABLE_LABEL_PT_BR "Ativa o turbo"
#define QUICKNES_TURBO_ENABLE_INFO_0_PT_BR "Habilita o uso dos botões de Turbo A e Turbo B."
#define OPTION_VAL_NONE_PT_BR "Nenhum"
#define OPTION_VAL_PLAYER_1_PT_BR "Jogador 1"
#define OPTION_VAL_PLAYER_2_PT_BR "Jogador 2"
#define OPTION_VAL_BOTH_PT_BR "Jogador 1 e 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_PT_BR "Comprimento do pressionamento do turbo (em quadros)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_PT_BR "Especifica tanto a duração do pressionamento como a do não pressionamento (em quadros) quando é apertado os botões Turbo A e Turbo B. Por exemplo, o valor padrão de 3 corresponde a a fórmula (60 ÷ (3 + 3)) = frequência de 10Hz do turbo (10 pressionamentos por segundo)."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_PT_BR "Permite direções contrárias"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_PT_BR "Esta opção permitirá pressionar, alternar ou segurar rapidamente as direções esquerda e direita (ou cima e baixo) ao mesmo tempo. Pode causar falhas de movimento."

struct retro_core_option_v2_category option_cats_pt_br[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_pt_br[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_PT_BR,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_PT_BR,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_PT_BR },
         { "4:3", OPTION_VAL_4_3_PT_BR },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_PT_BR,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_PT_BR,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_PT_BR,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_PT_BR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_PT_BR,
      NULL,
      QUICKNES_PALETTE_INFO_0_PT_BR,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_PT_BR },
         { "asqrealc",             OPTION_VAL_ASQREALC_PT_BR },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_PT_BR },
         { "rgb",                  OPTION_VAL_RGB_PT_BR },
         { "yuv-v3",               OPTION_VAL_YUV_V3_PT_BR },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_PT_BR },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_PT_BR },
         { "pal",                  OPTION_VAL_PAL_PT_BR },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_PT_BR },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_PT_BR },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_PT_BR },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_PT_BR },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_PT_BR },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_PT_BR },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_PT_BR },
         { "nescap",               OPTION_VAL_NESCAP_PT_BR },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_PT_BR },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_PT_BR,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_PT_BR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_PT_BR,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_PT_BR,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_PT_BR },
         { "linear",         OPTION_VAL_LINEAR_PT_BR },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_PT_BR },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_PT_BR,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_PT_BR,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_PT_BR },
         { "famicom", OPTION_VAL_FAMICOM_PT_BR },
         { "tv",      OPTION_VAL_TV_PT_BR },
         { "flat",    OPTION_VAL_FLAT_PT_BR },
         { "crisp",   OPTION_VAL_CRISP_PT_BR },
         { "tinny",   OPTION_VAL_TINNY_PT_BR },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_PT_BR,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_PT_BR,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_PT_BR },
         { "player 1", OPTION_VAL_PLAYER_1_PT_BR },
         { "player 2", OPTION_VAL_PLAYER_2_PT_BR },
         { "both",     OPTION_VAL_BOTH_PT_BR },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_PT_BR,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_PT_BR,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_PT_BR,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_PT_BR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_pt_br = {
   option_cats_pt_br,
   option_defs_pt_br
};

/* RETRO_LANGUAGE_PT_PT */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_PT_PT "Proporção do ecrã"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_PT_PT NULL
#define OPTION_VAL_PAR_PT_PT NULL
#define OPTION_VAL_4_3_PT_PT NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_PT_PT NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_PT_PT NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_PT_PT NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_PT_PT NULL
#define QUICKNES_PALETTE_LABEL_PT_PT NULL
#define QUICKNES_PALETTE_INFO_0_PT_PT NULL
#define OPTION_VAL_DEFAULT_PT_PT NULL
#define OPTION_VAL_ASQREALC_PT_PT NULL
#define OPTION_VAL_NINTENDO_VC_PT_PT NULL
#define OPTION_VAL_RGB_PT_PT NULL
#define OPTION_VAL_YUV_V3_PT_PT NULL
#define OPTION_VAL_UNSATURATED_FINAL_PT_PT NULL
#define OPTION_VAL_SONY_CXA2025AS_US_PT_PT NULL
#define OPTION_VAL_PAL_PT_PT NULL
#define OPTION_VAL_BMF_FINAL2_PT_PT NULL
#define OPTION_VAL_BMF_FINAL3_PT_PT NULL
#define OPTION_VAL_SMOOTH_FBX_PT_PT NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_PT_PT NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_PT_PT NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_PT_PT NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_PT_PT NULL
#define OPTION_VAL_NESCAP_PT_PT NULL
#define OPTION_VAL_WAVEBEAM_PT_PT NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_PT_PT NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_PT_PT NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_PT_PT NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_PT_PT NULL
#define OPTION_VAL_NONLINEAR_PT_PT NULL
#define OPTION_VAL_LINEAR_PT_PT NULL
#define OPTION_VAL_STEREO_PANNING_PT_PT NULL
#define QUICKNES_AUDIO_EQ_LABEL_PT_PT NULL
#define QUICKNES_AUDIO_EQ_INFO_0_PT_PT NULL
#define OPTION_VAL_FAMICOM_PT_PT NULL
#define OPTION_VAL_TV_PT_PT NULL
#define OPTION_VAL_FLAT_PT_PT NULL
#define OPTION_VAL_CRISP_PT_PT NULL
#define OPTION_VAL_TINNY_PT_PT NULL
#define QUICKNES_TURBO_ENABLE_LABEL_PT_PT NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_PT_PT NULL
#define OPTION_VAL_NONE_PT_PT "Nenhum"
#define OPTION_VAL_PLAYER_1_PT_PT NULL
#define OPTION_VAL_PLAYER_2_PT_PT NULL
#define OPTION_VAL_BOTH_PT_PT NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_PT_PT NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_PT_PT NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_PT_PT NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_PT_PT NULL

struct retro_core_option_v2_category option_cats_pt_pt[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_pt_pt[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_PT_PT,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_PT_PT,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_PT_PT },
         { "4:3", OPTION_VAL_4_3_PT_PT },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_PT_PT,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_PT_PT,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_PT_PT,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_PT_PT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_PT_PT,
      NULL,
      QUICKNES_PALETTE_INFO_0_PT_PT,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_PT_PT },
         { "asqrealc",             OPTION_VAL_ASQREALC_PT_PT },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_PT_PT },
         { "rgb",                  OPTION_VAL_RGB_PT_PT },
         { "yuv-v3",               OPTION_VAL_YUV_V3_PT_PT },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_PT_PT },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_PT_PT },
         { "pal",                  OPTION_VAL_PAL_PT_PT },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_PT_PT },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_PT_PT },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_PT_PT },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_PT_PT },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_PT_PT },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_PT_PT },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_PT_PT },
         { "nescap",               OPTION_VAL_NESCAP_PT_PT },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_PT_PT },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_PT_PT,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_PT_PT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_PT_PT,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_PT_PT,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_PT_PT },
         { "linear",         OPTION_VAL_LINEAR_PT_PT },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_PT_PT },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_PT_PT,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_PT_PT,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_PT_PT },
         { "famicom", OPTION_VAL_FAMICOM_PT_PT },
         { "tv",      OPTION_VAL_TV_PT_PT },
         { "flat",    OPTION_VAL_FLAT_PT_PT },
         { "crisp",   OPTION_VAL_CRISP_PT_PT },
         { "tinny",   OPTION_VAL_TINNY_PT_PT },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_PT_PT,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_PT_PT,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_PT_PT },
         { "player 1", OPTION_VAL_PLAYER_1_PT_PT },
         { "player 2", OPTION_VAL_PLAYER_2_PT_PT },
         { "both",     OPTION_VAL_BOTH_PT_PT },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_PT_PT,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_PT_PT,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_PT_PT,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_PT_PT,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_pt_pt = {
   option_cats_pt_pt,
   option_defs_pt_pt
};

/* RETRO_LANGUAGE_RO */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_RO NULL
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_RO NULL
#define OPTION_VAL_PAR_RO NULL
#define OPTION_VAL_4_3_RO NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_RO NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_RO NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_RO NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_RO NULL
#define QUICKNES_PALETTE_LABEL_RO NULL
#define QUICKNES_PALETTE_INFO_0_RO NULL
#define OPTION_VAL_DEFAULT_RO NULL
#define OPTION_VAL_ASQREALC_RO NULL
#define OPTION_VAL_NINTENDO_VC_RO NULL
#define OPTION_VAL_RGB_RO NULL
#define OPTION_VAL_YUV_V3_RO NULL
#define OPTION_VAL_UNSATURATED_FINAL_RO NULL
#define OPTION_VAL_SONY_CXA2025AS_US_RO NULL
#define OPTION_VAL_PAL_RO NULL
#define OPTION_VAL_BMF_FINAL2_RO NULL
#define OPTION_VAL_BMF_FINAL3_RO NULL
#define OPTION_VAL_SMOOTH_FBX_RO NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_RO NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_RO NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_RO NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_RO NULL
#define OPTION_VAL_NESCAP_RO NULL
#define OPTION_VAL_WAVEBEAM_RO NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_RO NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_RO NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_RO NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_RO NULL
#define OPTION_VAL_NONLINEAR_RO NULL
#define OPTION_VAL_LINEAR_RO NULL
#define OPTION_VAL_STEREO_PANNING_RO NULL
#define QUICKNES_AUDIO_EQ_LABEL_RO NULL
#define QUICKNES_AUDIO_EQ_INFO_0_RO NULL
#define OPTION_VAL_FAMICOM_RO NULL
#define OPTION_VAL_TV_RO NULL
#define OPTION_VAL_FLAT_RO NULL
#define OPTION_VAL_CRISP_RO NULL
#define OPTION_VAL_TINNY_RO NULL
#define QUICKNES_TURBO_ENABLE_LABEL_RO NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_RO NULL
#define OPTION_VAL_NONE_RO NULL
#define OPTION_VAL_PLAYER_1_RO NULL
#define OPTION_VAL_PLAYER_2_RO NULL
#define OPTION_VAL_BOTH_RO NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_RO NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_RO NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_RO NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_RO NULL

struct retro_core_option_v2_category option_cats_ro[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_ro[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_RO,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_RO,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_RO },
         { "4:3", OPTION_VAL_4_3_RO },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_RO,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_RO,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_RO,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_RO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_RO,
      NULL,
      QUICKNES_PALETTE_INFO_0_RO,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_RO },
         { "asqrealc",             OPTION_VAL_ASQREALC_RO },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_RO },
         { "rgb",                  OPTION_VAL_RGB_RO },
         { "yuv-v3",               OPTION_VAL_YUV_V3_RO },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_RO },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_RO },
         { "pal",                  OPTION_VAL_PAL_RO },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_RO },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_RO },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_RO },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_RO },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_RO },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_RO },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_RO },
         { "nescap",               OPTION_VAL_NESCAP_RO },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_RO },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_RO,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_RO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_RO,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_RO,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_RO },
         { "linear",         OPTION_VAL_LINEAR_RO },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_RO },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_RO,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_RO,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_RO },
         { "famicom", OPTION_VAL_FAMICOM_RO },
         { "tv",      OPTION_VAL_TV_RO },
         { "flat",    OPTION_VAL_FLAT_RO },
         { "crisp",   OPTION_VAL_CRISP_RO },
         { "tinny",   OPTION_VAL_TINNY_RO },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_RO,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_RO,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_RO },
         { "player 1", OPTION_VAL_PLAYER_1_RO },
         { "player 2", OPTION_VAL_PLAYER_2_RO },
         { "both",     OPTION_VAL_BOTH_RO },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_RO,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_RO,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_RO,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_RO,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_ro = {
   option_cats_ro,
   option_defs_ro
};

/* RETRO_LANGUAGE_RU */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_RU "Соотношение сторон"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_RU "Применяется, только если в видеонастройках RetroArch выбрано 'Core provided' для соотношения сторон."
#define OPTION_VAL_PAR_RU NULL
#define OPTION_VAL_4_3_RU NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_RU "Показывать гориз. вылеты развёртки"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_RU "Отключите, чтобы обрезать (по горизонтали) случайные искажения графики, которые обычно скрыты рамкой по краю экрана в телевизорах стандартной чёткости."
#define QUICKNES_USE_OVERSCAN_V_LABEL_RU "Показывать верт. вылеты развёртки"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_RU "Отключите, чтобы обрезать (по вертикали) случайные искажения графики, которые обычно скрыты рамкой по краю экрана в телевизорах стандартной чёткости."
#define QUICKNES_PALETTE_LABEL_RU "Цветовая палитра"
#define QUICKNES_PALETTE_INFO_0_RU "Выбор цветовой палитры, используемой при декодировании NES видеосигнала NTSC."
#define OPTION_VAL_DEFAULT_RU "По умолчанию"
#define OPTION_VAL_ASQREALC_RU NULL
#define OPTION_VAL_NINTENDO_VC_RU NULL
#define OPTION_VAL_RGB_RU NULL
#define OPTION_VAL_YUV_V3_RU NULL
#define OPTION_VAL_UNSATURATED_FINAL_RU NULL
#define OPTION_VAL_SONY_CXA2025AS_US_RU NULL
#define OPTION_VAL_PAL_RU NULL
#define OPTION_VAL_BMF_FINAL2_RU NULL
#define OPTION_VAL_BMF_FINAL3_RU NULL
#define OPTION_VAL_SMOOTH_FBX_RU NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_RU NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_RU NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_RU NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_RU "FBX's NES-Classic (исправленная)"
#define OPTION_VAL_NESCAP_RU NULL
#define OPTION_VAL_WAVEBEAM_RU NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_RU "Без ограничения спрайтов"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_RU "Убирает аппаратное ограничение в 8 спрайтов на линию развёртки. Уменьшает мерцание, но может вызывать графические баги, т.к. в некоторых играх аппаратное ограничение используется для создания спецэффектов."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_RU "Аудиорежим"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_RU "Настройка эмуляции звука. 'Нелинейный' имитирует нелинейное микширование блока обработки аудиосигналов NES. 'Линейное' использует точную аппроксимацию, снижая качество, но улучшая производительность на слабых устройствах. 'Стерео-панорамирование' добавляет глубину к монофоническому звучанию NES с помощью панорамирования и реверберации."
#define OPTION_VAL_NONLINEAR_RU "Нелинейный"
#define OPTION_VAL_LINEAR_RU "Линейный"
#define OPTION_VAL_STEREO_PANNING_RU "Стерео-панорамирование"
#define QUICKNES_AUDIO_EQ_LABEL_RU "Пресет эквалайзера"
#define QUICKNES_AUDIO_EQ_INFO_0_RU "Регулировка баланса между частотами диапазона с помощью предустановок эквалайзера."
#define OPTION_VAL_FAMICOM_RU NULL
#define OPTION_VAL_TV_RU "ТВ"
#define OPTION_VAL_FLAT_RU "Плоский"
#define OPTION_VAL_CRISP_RU "Чёткий"
#define OPTION_VAL_TINNY_RU "Жестяной"
#define QUICKNES_TURBO_ENABLE_LABEL_RU "Включить турбо"
#define QUICKNES_TURBO_ENABLE_INFO_0_RU "Активирует использование кнопок Turbo A и Turbo B."
#define OPTION_VAL_NONE_RU "Нет"
#define OPTION_VAL_PLAYER_1_RU "Игрок 1"
#define OPTION_VAL_PLAYER_2_RU "Игрок 2"
#define OPTION_VAL_BOTH_RU "Игроки 1 & 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_RU "Ширина турбо-импульса (в кадрах)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_RU "Устанавливает ширину и интервал (в кадрах) для выходных импульсов при удерживании кнопок Turbo A и Turbo B. Например, значение по умолчанию '3' соответствует частоте турбо (60/(3+3)) = 10 Гц (10 нажатий в секунду)."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_RU "Разрешить нажатия в разные стороны"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_RU "Позволяет нажимать / быстро менять / зажимать одновременно направления влево и вправо (или вверх и вниз). Может вызывать глитчи, связанные с перемещением."

struct retro_core_option_v2_category option_cats_ru[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_ru[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_RU,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_RU,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_RU },
         { "4:3", OPTION_VAL_4_3_RU },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_RU,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_RU,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_RU,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_RU,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_RU,
      NULL,
      QUICKNES_PALETTE_INFO_0_RU,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_RU },
         { "asqrealc",             OPTION_VAL_ASQREALC_RU },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_RU },
         { "rgb",                  OPTION_VAL_RGB_RU },
         { "yuv-v3",               OPTION_VAL_YUV_V3_RU },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_RU },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_RU },
         { "pal",                  OPTION_VAL_PAL_RU },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_RU },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_RU },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_RU },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_RU },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_RU },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_RU },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_RU },
         { "nescap",               OPTION_VAL_NESCAP_RU },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_RU },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_RU,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_RU,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_RU,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_RU,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_RU },
         { "linear",         OPTION_VAL_LINEAR_RU },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_RU },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_RU,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_RU,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_RU },
         { "famicom", OPTION_VAL_FAMICOM_RU },
         { "tv",      OPTION_VAL_TV_RU },
         { "flat",    OPTION_VAL_FLAT_RU },
         { "crisp",   OPTION_VAL_CRISP_RU },
         { "tinny",   OPTION_VAL_TINNY_RU },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_RU,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_RU,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_RU },
         { "player 1", OPTION_VAL_PLAYER_1_RU },
         { "player 2", OPTION_VAL_PLAYER_2_RU },
         { "both",     OPTION_VAL_BOTH_RU },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_RU,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_RU,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_RU,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_RU,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_ru = {
   option_cats_ru,
   option_defs_ru
};

/* RETRO_LANGUAGE_SI */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_SI NULL
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_SI NULL
#define OPTION_VAL_PAR_SI NULL
#define OPTION_VAL_4_3_SI NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_SI NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_SI NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_SI NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_SI NULL
#define QUICKNES_PALETTE_LABEL_SI NULL
#define QUICKNES_PALETTE_INFO_0_SI NULL
#define OPTION_VAL_DEFAULT_SI NULL
#define OPTION_VAL_ASQREALC_SI NULL
#define OPTION_VAL_NINTENDO_VC_SI NULL
#define OPTION_VAL_RGB_SI NULL
#define OPTION_VAL_YUV_V3_SI NULL
#define OPTION_VAL_UNSATURATED_FINAL_SI NULL
#define OPTION_VAL_SONY_CXA2025AS_US_SI NULL
#define OPTION_VAL_PAL_SI NULL
#define OPTION_VAL_BMF_FINAL2_SI NULL
#define OPTION_VAL_BMF_FINAL3_SI NULL
#define OPTION_VAL_SMOOTH_FBX_SI NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_SI NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_SI NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_SI NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_SI NULL
#define OPTION_VAL_NESCAP_SI NULL
#define OPTION_VAL_WAVEBEAM_SI NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_SI NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_SI NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_SI NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_SI NULL
#define OPTION_VAL_NONLINEAR_SI NULL
#define OPTION_VAL_LINEAR_SI NULL
#define OPTION_VAL_STEREO_PANNING_SI NULL
#define QUICKNES_AUDIO_EQ_LABEL_SI NULL
#define QUICKNES_AUDIO_EQ_INFO_0_SI NULL
#define OPTION_VAL_FAMICOM_SI NULL
#define OPTION_VAL_TV_SI NULL
#define OPTION_VAL_FLAT_SI NULL
#define OPTION_VAL_CRISP_SI NULL
#define OPTION_VAL_TINNY_SI NULL
#define QUICKNES_TURBO_ENABLE_LABEL_SI NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_SI NULL
#define OPTION_VAL_NONE_SI NULL
#define OPTION_VAL_PLAYER_1_SI NULL
#define OPTION_VAL_PLAYER_2_SI NULL
#define OPTION_VAL_BOTH_SI NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_SI NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_SI NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_SI NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_SI NULL

struct retro_core_option_v2_category option_cats_si[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_si[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_SI,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_SI,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_SI },
         { "4:3", OPTION_VAL_4_3_SI },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_SI,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_SI,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_SI,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_SI,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_SI,
      NULL,
      QUICKNES_PALETTE_INFO_0_SI,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_SI },
         { "asqrealc",             OPTION_VAL_ASQREALC_SI },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_SI },
         { "rgb",                  OPTION_VAL_RGB_SI },
         { "yuv-v3",               OPTION_VAL_YUV_V3_SI },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_SI },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_SI },
         { "pal",                  OPTION_VAL_PAL_SI },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_SI },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_SI },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_SI },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_SI },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_SI },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_SI },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_SI },
         { "nescap",               OPTION_VAL_NESCAP_SI },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_SI },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_SI,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_SI,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_SI,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_SI,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_SI },
         { "linear",         OPTION_VAL_LINEAR_SI },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_SI },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_SI,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_SI,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_SI },
         { "famicom", OPTION_VAL_FAMICOM_SI },
         { "tv",      OPTION_VAL_TV_SI },
         { "flat",    OPTION_VAL_FLAT_SI },
         { "crisp",   OPTION_VAL_CRISP_SI },
         { "tinny",   OPTION_VAL_TINNY_SI },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_SI,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_SI,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_SI },
         { "player 1", OPTION_VAL_PLAYER_1_SI },
         { "player 2", OPTION_VAL_PLAYER_2_SI },
         { "both",     OPTION_VAL_BOTH_SI },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_SI,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_SI,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_SI,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_SI,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_si = {
   option_cats_si,
   option_defs_si
};

/* RETRO_LANGUAGE_SK */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_SK "Pomer strán"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_SK NULL
#define OPTION_VAL_PAR_SK NULL
#define OPTION_VAL_4_3_SK NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_SK NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_SK NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_SK NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_SK NULL
#define QUICKNES_PALETTE_LABEL_SK "Farebná paleta"
#define QUICKNES_PALETTE_INFO_0_SK NULL
#define OPTION_VAL_DEFAULT_SK "Predvolené"
#define OPTION_VAL_ASQREALC_SK NULL
#define OPTION_VAL_NINTENDO_VC_SK NULL
#define OPTION_VAL_RGB_SK NULL
#define OPTION_VAL_YUV_V3_SK NULL
#define OPTION_VAL_UNSATURATED_FINAL_SK NULL
#define OPTION_VAL_SONY_CXA2025AS_US_SK NULL
#define OPTION_VAL_PAL_SK NULL
#define OPTION_VAL_BMF_FINAL2_SK NULL
#define OPTION_VAL_BMF_FINAL3_SK NULL
#define OPTION_VAL_SMOOTH_FBX_SK NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_SK NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_SK NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_SK NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_SK NULL
#define OPTION_VAL_NESCAP_SK NULL
#define OPTION_VAL_WAVEBEAM_SK NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_SK NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_SK NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_SK NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_SK NULL
#define OPTION_VAL_NONLINEAR_SK NULL
#define OPTION_VAL_LINEAR_SK "Lineárny"
#define OPTION_VAL_STEREO_PANNING_SK NULL
#define QUICKNES_AUDIO_EQ_LABEL_SK NULL
#define QUICKNES_AUDIO_EQ_INFO_0_SK NULL
#define OPTION_VAL_FAMICOM_SK NULL
#define OPTION_VAL_TV_SK NULL
#define OPTION_VAL_FLAT_SK "Ploché"
#define OPTION_VAL_CRISP_SK NULL
#define OPTION_VAL_TINNY_SK NULL
#define QUICKNES_TURBO_ENABLE_LABEL_SK "Povoliť Turbo"
#define QUICKNES_TURBO_ENABLE_INFO_0_SK NULL
#define OPTION_VAL_NONE_SK "Žiadne"
#define OPTION_VAL_PLAYER_1_SK "Hráč 1"
#define OPTION_VAL_PLAYER_2_SK "Hráč 2"
#define OPTION_VAL_BOTH_SK "Hráč 1 & 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_SK NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_SK NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_SK NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_SK NULL

struct retro_core_option_v2_category option_cats_sk[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_sk[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_SK,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_SK,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_SK },
         { "4:3", OPTION_VAL_4_3_SK },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_SK,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_SK,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_SK,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_SK,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_SK,
      NULL,
      QUICKNES_PALETTE_INFO_0_SK,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_SK },
         { "asqrealc",             OPTION_VAL_ASQREALC_SK },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_SK },
         { "rgb",                  OPTION_VAL_RGB_SK },
         { "yuv-v3",               OPTION_VAL_YUV_V3_SK },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_SK },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_SK },
         { "pal",                  OPTION_VAL_PAL_SK },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_SK },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_SK },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_SK },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_SK },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_SK },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_SK },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_SK },
         { "nescap",               OPTION_VAL_NESCAP_SK },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_SK },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_SK,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_SK,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_SK,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_SK,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_SK },
         { "linear",         OPTION_VAL_LINEAR_SK },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_SK },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_SK,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_SK,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_SK },
         { "famicom", OPTION_VAL_FAMICOM_SK },
         { "tv",      OPTION_VAL_TV_SK },
         { "flat",    OPTION_VAL_FLAT_SK },
         { "crisp",   OPTION_VAL_CRISP_SK },
         { "tinny",   OPTION_VAL_TINNY_SK },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_SK,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_SK,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_SK },
         { "player 1", OPTION_VAL_PLAYER_1_SK },
         { "player 2", OPTION_VAL_PLAYER_2_SK },
         { "both",     OPTION_VAL_BOTH_SK },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_SK,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_SK,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_SK,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_SK,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_sk = {
   option_cats_sk,
   option_defs_sk
};

/* RETRO_LANGUAGE_SR */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_SR "Odnos ekrana"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_SR NULL
#define OPTION_VAL_PAR_SR NULL
#define OPTION_VAL_4_3_SR NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_SR NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_SR NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_SR NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_SR NULL
#define QUICKNES_PALETTE_LABEL_SR NULL
#define QUICKNES_PALETTE_INFO_0_SR NULL
#define OPTION_VAL_DEFAULT_SR NULL
#define OPTION_VAL_ASQREALC_SR NULL
#define OPTION_VAL_NINTENDO_VC_SR NULL
#define OPTION_VAL_RGB_SR NULL
#define OPTION_VAL_YUV_V3_SR NULL
#define OPTION_VAL_UNSATURATED_FINAL_SR NULL
#define OPTION_VAL_SONY_CXA2025AS_US_SR NULL
#define OPTION_VAL_PAL_SR NULL
#define OPTION_VAL_BMF_FINAL2_SR NULL
#define OPTION_VAL_BMF_FINAL3_SR NULL
#define OPTION_VAL_SMOOTH_FBX_SR NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_SR NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_SR NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_SR NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_SR NULL
#define OPTION_VAL_NESCAP_SR NULL
#define OPTION_VAL_WAVEBEAM_SR NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_SR NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_SR NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_SR NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_SR NULL
#define OPTION_VAL_NONLINEAR_SR NULL
#define OPTION_VAL_LINEAR_SR NULL
#define OPTION_VAL_STEREO_PANNING_SR NULL
#define QUICKNES_AUDIO_EQ_LABEL_SR NULL
#define QUICKNES_AUDIO_EQ_INFO_0_SR NULL
#define OPTION_VAL_FAMICOM_SR NULL
#define OPTION_VAL_TV_SR NULL
#define OPTION_VAL_FLAT_SR NULL
#define OPTION_VAL_CRISP_SR NULL
#define OPTION_VAL_TINNY_SR NULL
#define QUICKNES_TURBO_ENABLE_LABEL_SR NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_SR NULL
#define OPTION_VAL_NONE_SR NULL
#define OPTION_VAL_PLAYER_1_SR NULL
#define OPTION_VAL_PLAYER_2_SR NULL
#define OPTION_VAL_BOTH_SR NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_SR NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_SR NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_SR NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_SR NULL

struct retro_core_option_v2_category option_cats_sr[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_sr[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_SR,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_SR,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_SR },
         { "4:3", OPTION_VAL_4_3_SR },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_SR,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_SR,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_SR,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_SR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_SR,
      NULL,
      QUICKNES_PALETTE_INFO_0_SR,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_SR },
         { "asqrealc",             OPTION_VAL_ASQREALC_SR },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_SR },
         { "rgb",                  OPTION_VAL_RGB_SR },
         { "yuv-v3",               OPTION_VAL_YUV_V3_SR },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_SR },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_SR },
         { "pal",                  OPTION_VAL_PAL_SR },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_SR },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_SR },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_SR },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_SR },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_SR },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_SR },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_SR },
         { "nescap",               OPTION_VAL_NESCAP_SR },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_SR },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_SR,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_SR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_SR,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_SR,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_SR },
         { "linear",         OPTION_VAL_LINEAR_SR },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_SR },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_SR,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_SR,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_SR },
         { "famicom", OPTION_VAL_FAMICOM_SR },
         { "tv",      OPTION_VAL_TV_SR },
         { "flat",    OPTION_VAL_FLAT_SR },
         { "crisp",   OPTION_VAL_CRISP_SR },
         { "tinny",   OPTION_VAL_TINNY_SR },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_SR,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_SR,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_SR },
         { "player 1", OPTION_VAL_PLAYER_1_SR },
         { "player 2", OPTION_VAL_PLAYER_2_SR },
         { "both",     OPTION_VAL_BOTH_SR },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_SR,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_SR,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_SR,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_SR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_sr = {
   option_cats_sr,
   option_defs_sr
};

/* RETRO_LANGUAGE_SV */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_SV "Bildförhållande"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_SV NULL
#define OPTION_VAL_PAR_SV NULL
#define OPTION_VAL_4_3_SV NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_SV NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_SV NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_SV NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_SV NULL
#define QUICKNES_PALETTE_LABEL_SV "Färgpalett"
#define QUICKNES_PALETTE_INFO_0_SV NULL
#define OPTION_VAL_DEFAULT_SV NULL
#define OPTION_VAL_ASQREALC_SV NULL
#define OPTION_VAL_NINTENDO_VC_SV NULL
#define OPTION_VAL_RGB_SV NULL
#define OPTION_VAL_YUV_V3_SV NULL
#define OPTION_VAL_UNSATURATED_FINAL_SV NULL
#define OPTION_VAL_SONY_CXA2025AS_US_SV NULL
#define OPTION_VAL_PAL_SV NULL
#define OPTION_VAL_BMF_FINAL2_SV NULL
#define OPTION_VAL_BMF_FINAL3_SV NULL
#define OPTION_VAL_SMOOTH_FBX_SV NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_SV NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_SV NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_SV NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_SV NULL
#define OPTION_VAL_NESCAP_SV NULL
#define OPTION_VAL_WAVEBEAM_SV NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_SV NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_SV NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_SV "Ljudläge"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_SV NULL
#define OPTION_VAL_NONLINEAR_SV NULL
#define OPTION_VAL_LINEAR_SV "Linjär"
#define OPTION_VAL_STEREO_PANNING_SV NULL
#define QUICKNES_AUDIO_EQ_LABEL_SV NULL
#define QUICKNES_AUDIO_EQ_INFO_0_SV NULL
#define OPTION_VAL_FAMICOM_SV NULL
#define OPTION_VAL_TV_SV NULL
#define OPTION_VAL_FLAT_SV NULL
#define OPTION_VAL_CRISP_SV NULL
#define OPTION_VAL_TINNY_SV NULL
#define QUICKNES_TURBO_ENABLE_LABEL_SV NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_SV NULL
#define OPTION_VAL_NONE_SV "Ingen"
#define OPTION_VAL_PLAYER_1_SV "Spelare 1"
#define OPTION_VAL_PLAYER_2_SV "Spelare 2"
#define OPTION_VAL_BOTH_SV "Spelare 1 & 2"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_SV NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_SV NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_SV NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_SV NULL

struct retro_core_option_v2_category option_cats_sv[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_sv[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_SV,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_SV,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_SV },
         { "4:3", OPTION_VAL_4_3_SV },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_SV,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_SV,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_SV,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_SV,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_SV,
      NULL,
      QUICKNES_PALETTE_INFO_0_SV,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_SV },
         { "asqrealc",             OPTION_VAL_ASQREALC_SV },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_SV },
         { "rgb",                  OPTION_VAL_RGB_SV },
         { "yuv-v3",               OPTION_VAL_YUV_V3_SV },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_SV },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_SV },
         { "pal",                  OPTION_VAL_PAL_SV },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_SV },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_SV },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_SV },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_SV },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_SV },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_SV },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_SV },
         { "nescap",               OPTION_VAL_NESCAP_SV },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_SV },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_SV,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_SV,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_SV,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_SV,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_SV },
         { "linear",         OPTION_VAL_LINEAR_SV },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_SV },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_SV,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_SV,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_SV },
         { "famicom", OPTION_VAL_FAMICOM_SV },
         { "tv",      OPTION_VAL_TV_SV },
         { "flat",    OPTION_VAL_FLAT_SV },
         { "crisp",   OPTION_VAL_CRISP_SV },
         { "tinny",   OPTION_VAL_TINNY_SV },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_SV,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_SV,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_SV },
         { "player 1", OPTION_VAL_PLAYER_1_SV },
         { "player 2", OPTION_VAL_PLAYER_2_SV },
         { "both",     OPTION_VAL_BOTH_SV },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_SV,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_SV,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_SV,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_SV,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_sv = {
   option_cats_sv,
   option_defs_sv
};

/* RETRO_LANGUAGE_TR */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_TR "En Boy Oranı"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_TR "Bu, yalnızca RetroArch en boy oranı Video ayarlarında 'Çekirdeğe özel' olarak ayarlandığında geçerli olacaktır."
#define OPTION_VAL_PAR_TR NULL
#define OPTION_VAL_4_3_TR NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_TR "Yatay Aşırı Taramayı Göster"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_TR "Standart tanımlı bir televizyon ekranının kenarındaki çerçeve tarafından gizlenmiş olabilecek olası rastgele arızalı video çıkışını (yatay olarak) kırpmak için bunu devre dışı bırakın."
#define QUICKNES_USE_OVERSCAN_V_LABEL_TR "Dikey Aşırı Taramayı Göster"
#define QUICKNES_USE_OVERSCAN_V_INFO_0_TR "Standart tanımlı bir televizyon ekranının kenarındaki çerçeve tarafından gizlenmiş olabilecek olası rastgele arızalı video çıkışını (dikey olarak) kırpmak için bunu devre dışı bırakın."
#define QUICKNES_PALETTE_LABEL_TR "Renk Paleti"
#define QUICKNES_PALETTE_INFO_0_TR "NES tarafından NTSC video sinyali çıkışının kodunu çözerken hangi renk paletinin kullanılacağını belirtir."
#define OPTION_VAL_DEFAULT_TR "Varsayılan"
#define OPTION_VAL_ASQREALC_TR NULL
#define OPTION_VAL_NINTENDO_VC_TR NULL
#define OPTION_VAL_RGB_TR NULL
#define OPTION_VAL_YUV_V3_TR NULL
#define OPTION_VAL_UNSATURATED_FINAL_TR NULL
#define OPTION_VAL_SONY_CXA2025AS_US_TR NULL
#define OPTION_VAL_PAL_TR NULL
#define OPTION_VAL_BMF_FINAL2_TR NULL
#define OPTION_VAL_BMF_FINAL3_TR NULL
#define OPTION_VAL_SMOOTH_FBX_TR NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_TR NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_TR NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_TR NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_TR NULL
#define OPTION_VAL_NESCAP_TR NULL
#define OPTION_VAL_WAVEBEAM_TR NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_TR "Hareket Sınırını Kaldır"
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_TR "Tarama satırı başına 8 hareketli grafik donanım sınırını kaldırır. Bu, titremeyi azaltır ancak bazı oyunlar özel efektler oluşturmak için donanım sınırını kullandığından görsel hatalara neden olabilir."
#define QUICKNES_AUDIO_NONLINEAR_LABEL_TR "Ses Kipi"
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_TR "Ses taklidini yapılandırın. 'Doğrusal Olmayan', NES APU'nun doğrusal olmayan kanal karıştırmasını taklit eder. 'Doğrusal', kaliteyi düşüren ancak düşük kaliteli donanımlarda performansı artıran daha az doğru bir tahmin kullanır. 'Stereo Kaydırma', kaydırma teknikleri ve yankı efektlerinin kullanımı yoluyla NES mono çıkışına derinlik katar."
#define OPTION_VAL_NONLINEAR_TR "Doğrusal Olmayan"
#define OPTION_VAL_LINEAR_TR "Doğrusal"
#define OPTION_VAL_STEREO_PANNING_TR "Stereo Kaydırma"
#define QUICKNES_AUDIO_EQ_LABEL_TR "Ses Karıştırıcı Ön Ayarı"
#define QUICKNES_AUDIO_EQ_INFO_0_TR "Özel bir karıştırıcı ön ayarıyla ses frekansı bileşenleri arasındaki dengeyi ayarlayın."
#define OPTION_VAL_FAMICOM_TR NULL
#define OPTION_VAL_TV_TR NULL
#define OPTION_VAL_FLAT_TR "Düz"
#define OPTION_VAL_CRISP_TR "Kıvrımlı"
#define OPTION_VAL_TINNY_TR "Teneke"
#define QUICKNES_TURBO_ENABLE_LABEL_TR "Turbo'yu Etkinleştir"
#define QUICKNES_TURBO_ENABLE_INFO_0_TR "Turbo A ve Turbo B düğmelerinin kullanılmasını sağlar."
#define OPTION_VAL_NONE_TR "Hiçbiri"
#define OPTION_VAL_PLAYER_1_TR "1. Oyuncu"
#define OPTION_VAL_PLAYER_2_TR "2. Oyuncu"
#define OPTION_VAL_BOTH_TR "İkisi içinde"
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_TR "Turbo Darbe Genişliği (çerçevelerde)"
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_TR "Turbo A ve Turbo B düğmeleri basılı tutulduğunda 'darbeler' girişinin hem genişliğini hem de aralığını (çerçevelerde) belirtir. Örneğin, varsayılan '3' ayarı a (60/(3+3)) = 10 Hz turbo frekansına (saniyede 10 basma) karşılık gelir."
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_TR "Karşı Yönlere İzin Ver"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_TR "Bunun etkinleştirilmesi, aynı anda hem sol hem de sağ (veya yukarı ve aşağı) yönlere basılmasına / hızlı bir şekilde değiştirilmesine / basılı tutulmasına olanak tanır. Bu, hareket tabanlı aksaklıklara neden olabilir."

struct retro_core_option_v2_category option_cats_tr[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_tr[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_TR,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_TR,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_TR },
         { "4:3", OPTION_VAL_4_3_TR },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_TR,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_TR,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_TR,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_TR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_TR,
      NULL,
      QUICKNES_PALETTE_INFO_0_TR,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_TR },
         { "asqrealc",             OPTION_VAL_ASQREALC_TR },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_TR },
         { "rgb",                  OPTION_VAL_RGB_TR },
         { "yuv-v3",               OPTION_VAL_YUV_V3_TR },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_TR },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_TR },
         { "pal",                  OPTION_VAL_PAL_TR },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_TR },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_TR },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_TR },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_TR },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_TR },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_TR },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_TR },
         { "nescap",               OPTION_VAL_NESCAP_TR },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_TR },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_TR,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_TR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_TR,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_TR,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_TR },
         { "linear",         OPTION_VAL_LINEAR_TR },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_TR },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_TR,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_TR,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_TR },
         { "famicom", OPTION_VAL_FAMICOM_TR },
         { "tv",      OPTION_VAL_TV_TR },
         { "flat",    OPTION_VAL_FLAT_TR },
         { "crisp",   OPTION_VAL_CRISP_TR },
         { "tinny",   OPTION_VAL_TINNY_TR },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_TR,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_TR,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_TR },
         { "player 1", OPTION_VAL_PLAYER_1_TR },
         { "player 2", OPTION_VAL_PLAYER_2_TR },
         { "both",     OPTION_VAL_BOTH_TR },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_TR,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_TR,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_TR,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_TR,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_tr = {
   option_cats_tr,
   option_defs_tr
};

/* RETRO_LANGUAGE_UK */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_UK "Співвідношення сторін"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_UK "Це буде застосовуватися тільки коли співвідношення сторін встановлено як 'Ядро' в налаштуваннях відео."
#define OPTION_VAL_PAR_UK NULL
#define OPTION_VAL_4_3_UK NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_UK "Показати горизонтальну розгортку"
#define QUICKNES_USE_OVERSCAN_H_INFO_0_UK NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_UK NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_UK NULL
#define QUICKNES_PALETTE_LABEL_UK "Кольорова палітра"
#define QUICKNES_PALETTE_INFO_0_UK NULL
#define OPTION_VAL_DEFAULT_UK "За замовчуванням"
#define OPTION_VAL_ASQREALC_UK NULL
#define OPTION_VAL_NINTENDO_VC_UK NULL
#define OPTION_VAL_RGB_UK NULL
#define OPTION_VAL_YUV_V3_UK NULL
#define OPTION_VAL_UNSATURATED_FINAL_UK NULL
#define OPTION_VAL_SONY_CXA2025AS_US_UK NULL
#define OPTION_VAL_PAL_UK NULL
#define OPTION_VAL_BMF_FINAL2_UK NULL
#define OPTION_VAL_BMF_FINAL3_UK NULL
#define OPTION_VAL_SMOOTH_FBX_UK NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_UK NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_UK NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_UK NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_UK NULL
#define OPTION_VAL_NESCAP_UK NULL
#define OPTION_VAL_WAVEBEAM_UK NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_UK NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_UK NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_UK NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_UK NULL
#define OPTION_VAL_NONLINEAR_UK NULL
#define OPTION_VAL_LINEAR_UK "Лінійна"
#define OPTION_VAL_STEREO_PANNING_UK NULL
#define QUICKNES_AUDIO_EQ_LABEL_UK NULL
#define QUICKNES_AUDIO_EQ_INFO_0_UK NULL
#define OPTION_VAL_FAMICOM_UK NULL
#define OPTION_VAL_TV_UK NULL
#define OPTION_VAL_FLAT_UK NULL
#define OPTION_VAL_CRISP_UK NULL
#define OPTION_VAL_TINNY_UK NULL
#define QUICKNES_TURBO_ENABLE_LABEL_UK NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_UK NULL
#define OPTION_VAL_NONE_UK NULL
#define OPTION_VAL_PLAYER_1_UK NULL
#define OPTION_VAL_PLAYER_2_UK NULL
#define OPTION_VAL_BOTH_UK NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_UK NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_UK NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_UK "Дозволити протилежні напрямки"
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_UK "Увімкнення цього дозволить одночасно натискати / швидко чергувати/утримувати одночасно ліворуч та праворуч (чи донизу) напрямки. Це може спричинити глітчі руху."

struct retro_core_option_v2_category option_cats_uk[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_uk[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_UK,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_UK,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_UK },
         { "4:3", OPTION_VAL_4_3_UK },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_UK,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_UK,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_UK,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_UK,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_UK,
      NULL,
      QUICKNES_PALETTE_INFO_0_UK,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_UK },
         { "asqrealc",             OPTION_VAL_ASQREALC_UK },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_UK },
         { "rgb",                  OPTION_VAL_RGB_UK },
         { "yuv-v3",               OPTION_VAL_YUV_V3_UK },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_UK },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_UK },
         { "pal",                  OPTION_VAL_PAL_UK },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_UK },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_UK },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_UK },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_UK },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_UK },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_UK },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_UK },
         { "nescap",               OPTION_VAL_NESCAP_UK },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_UK },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_UK,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_UK,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_UK,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_UK,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_UK },
         { "linear",         OPTION_VAL_LINEAR_UK },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_UK },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_UK,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_UK,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_UK },
         { "famicom", OPTION_VAL_FAMICOM_UK },
         { "tv",      OPTION_VAL_TV_UK },
         { "flat",    OPTION_VAL_FLAT_UK },
         { "crisp",   OPTION_VAL_CRISP_UK },
         { "tinny",   OPTION_VAL_TINNY_UK },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_UK,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_UK,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_UK },
         { "player 1", OPTION_VAL_PLAYER_1_UK },
         { "player 2", OPTION_VAL_PLAYER_2_UK },
         { "both",     OPTION_VAL_BOTH_UK },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_UK,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_UK,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_UK,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_UK,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_uk = {
   option_cats_uk,
   option_defs_uk
};

/* RETRO_LANGUAGE_VAL */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_VAL "Relació d'aspecte"
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_VAL NULL
#define OPTION_VAL_PAR_VAL NULL
#define OPTION_VAL_4_3_VAL NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_VAL NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_VAL NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_VAL NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_VAL NULL
#define QUICKNES_PALETTE_LABEL_VAL NULL
#define QUICKNES_PALETTE_INFO_0_VAL NULL
#define OPTION_VAL_DEFAULT_VAL NULL
#define OPTION_VAL_ASQREALC_VAL NULL
#define OPTION_VAL_NINTENDO_VC_VAL NULL
#define OPTION_VAL_RGB_VAL NULL
#define OPTION_VAL_YUV_V3_VAL NULL
#define OPTION_VAL_UNSATURATED_FINAL_VAL NULL
#define OPTION_VAL_SONY_CXA2025AS_US_VAL NULL
#define OPTION_VAL_PAL_VAL NULL
#define OPTION_VAL_BMF_FINAL2_VAL NULL
#define OPTION_VAL_BMF_FINAL3_VAL NULL
#define OPTION_VAL_SMOOTH_FBX_VAL NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_VAL NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_VAL NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_VAL NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_VAL NULL
#define OPTION_VAL_NESCAP_VAL NULL
#define OPTION_VAL_WAVEBEAM_VAL NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_VAL NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_VAL NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_VAL NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_VAL NULL
#define OPTION_VAL_NONLINEAR_VAL NULL
#define OPTION_VAL_LINEAR_VAL NULL
#define OPTION_VAL_STEREO_PANNING_VAL NULL
#define QUICKNES_AUDIO_EQ_LABEL_VAL NULL
#define QUICKNES_AUDIO_EQ_INFO_0_VAL NULL
#define OPTION_VAL_FAMICOM_VAL NULL
#define OPTION_VAL_TV_VAL NULL
#define OPTION_VAL_FLAT_VAL NULL
#define OPTION_VAL_CRISP_VAL NULL
#define OPTION_VAL_TINNY_VAL NULL
#define QUICKNES_TURBO_ENABLE_LABEL_VAL NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_VAL NULL
#define OPTION_VAL_NONE_VAL "Cap"
#define OPTION_VAL_PLAYER_1_VAL NULL
#define OPTION_VAL_PLAYER_2_VAL NULL
#define OPTION_VAL_BOTH_VAL NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_VAL NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_VAL NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_VAL NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_VAL NULL

struct retro_core_option_v2_category option_cats_val[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_val[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_VAL,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_VAL,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_VAL },
         { "4:3", OPTION_VAL_4_3_VAL },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_VAL,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_VAL,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_VAL,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_VAL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_VAL,
      NULL,
      QUICKNES_PALETTE_INFO_0_VAL,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_VAL },
         { "asqrealc",             OPTION_VAL_ASQREALC_VAL },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_VAL },
         { "rgb",                  OPTION_VAL_RGB_VAL },
         { "yuv-v3",               OPTION_VAL_YUV_V3_VAL },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_VAL },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_VAL },
         { "pal",                  OPTION_VAL_PAL_VAL },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_VAL },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_VAL },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_VAL },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_VAL },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_VAL },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_VAL },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_VAL },
         { "nescap",               OPTION_VAL_NESCAP_VAL },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_VAL },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_VAL,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_VAL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_VAL,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_VAL,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_VAL },
         { "linear",         OPTION_VAL_LINEAR_VAL },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_VAL },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_VAL,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_VAL,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_VAL },
         { "famicom", OPTION_VAL_FAMICOM_VAL },
         { "tv",      OPTION_VAL_TV_VAL },
         { "flat",    OPTION_VAL_FLAT_VAL },
         { "crisp",   OPTION_VAL_CRISP_VAL },
         { "tinny",   OPTION_VAL_TINNY_VAL },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_VAL,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_VAL,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_VAL },
         { "player 1", OPTION_VAL_PLAYER_1_VAL },
         { "player 2", OPTION_VAL_PLAYER_2_VAL },
         { "both",     OPTION_VAL_BOTH_VAL },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_VAL,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_VAL,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_VAL,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_VAL,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_val = {
   option_cats_val,
   option_defs_val
};

/* RETRO_LANGUAGE_VN */

#define QUICKNES_ASPECT_RATIO_PAR_LABEL_VN NULL
#define QUICKNES_ASPECT_RATIO_PAR_INFO_0_VN NULL
#define OPTION_VAL_PAR_VN NULL
#define OPTION_VAL_4_3_VN NULL
#define QUICKNES_USE_OVERSCAN_H_LABEL_VN NULL
#define QUICKNES_USE_OVERSCAN_H_INFO_0_VN NULL
#define QUICKNES_USE_OVERSCAN_V_LABEL_VN NULL
#define QUICKNES_USE_OVERSCAN_V_INFO_0_VN NULL
#define QUICKNES_PALETTE_LABEL_VN "Bảng màu"
#define QUICKNES_PALETTE_INFO_0_VN NULL
#define OPTION_VAL_DEFAULT_VN NULL
#define OPTION_VAL_ASQREALC_VN NULL
#define OPTION_VAL_NINTENDO_VC_VN NULL
#define OPTION_VAL_RGB_VN NULL
#define OPTION_VAL_YUV_V3_VN NULL
#define OPTION_VAL_UNSATURATED_FINAL_VN NULL
#define OPTION_VAL_SONY_CXA2025AS_US_VN NULL
#define OPTION_VAL_PAL_VN NULL
#define OPTION_VAL_BMF_FINAL2_VN NULL
#define OPTION_VAL_BMF_FINAL3_VN NULL
#define OPTION_VAL_SMOOTH_FBX_VN NULL
#define OPTION_VAL_COMPOSITE_DIRECT_FBX_VN NULL
#define OPTION_VAL_PVM_STYLE_D93_FBX_VN NULL
#define OPTION_VAL_NTSC_HARDWARE_FBX_VN NULL
#define OPTION_VAL_NES_CLASSIC_FBX_FS_VN NULL
#define OPTION_VAL_NESCAP_VN NULL
#define OPTION_VAL_WAVEBEAM_VN NULL
#define QUICKNES_NO_SPRITE_LIMIT_LABEL_VN NULL
#define QUICKNES_NO_SPRITE_LIMIT_INFO_0_VN NULL
#define QUICKNES_AUDIO_NONLINEAR_LABEL_VN NULL
#define QUICKNES_AUDIO_NONLINEAR_INFO_0_VN NULL
#define OPTION_VAL_NONLINEAR_VN NULL
#define OPTION_VAL_LINEAR_VN NULL
#define OPTION_VAL_STEREO_PANNING_VN NULL
#define QUICKNES_AUDIO_EQ_LABEL_VN NULL
#define QUICKNES_AUDIO_EQ_INFO_0_VN NULL
#define OPTION_VAL_FAMICOM_VN NULL
#define OPTION_VAL_TV_VN NULL
#define OPTION_VAL_FLAT_VN NULL
#define OPTION_VAL_CRISP_VN NULL
#define OPTION_VAL_TINNY_VN NULL
#define QUICKNES_TURBO_ENABLE_LABEL_VN NULL
#define QUICKNES_TURBO_ENABLE_INFO_0_VN NULL
#define OPTION_VAL_NONE_VN "Không"
#define OPTION_VAL_PLAYER_1_VN NULL
#define OPTION_VAL_PLAYER_2_VN NULL
#define OPTION_VAL_BOTH_VN NULL
#define QUICKNES_TURBO_PULSE_WIDTH_LABEL_VN NULL
#define QUICKNES_TURBO_PULSE_WIDTH_INFO_0_VN NULL
#define QUICKNES_UP_DOWN_ALLOWED_LABEL_VN NULL
#define QUICKNES_UP_DOWN_ALLOWED_INFO_0_VN NULL

struct retro_core_option_v2_category option_cats_vn[] = {
   { NULL, NULL, NULL },
};
struct retro_core_option_v2_definition option_defs_vn[] = {
   {
      "quicknes_aspect_ratio_par",
      QUICKNES_ASPECT_RATIO_PAR_LABEL_VN,
      NULL,
      QUICKNES_ASPECT_RATIO_PAR_INFO_0_VN,
      NULL,
      NULL,
      {
         { "PAR", OPTION_VAL_PAR_VN },
         { "4:3", OPTION_VAL_4_3_VN },
         { NULL, NULL },
      },
      "PAR",
   },
#ifndef PSP
   {
      "quicknes_use_overscan_h",
      QUICKNES_USE_OVERSCAN_H_LABEL_VN,
      NULL,
      QUICKNES_USE_OVERSCAN_H_INFO_0_VN,
      NULL,
      NULL,
      {
         { "enabled",  NULL },
         { "disabled", NULL },
         { NULL, NULL},
      },
      "enabled",
   },
   {
      "quicknes_use_overscan_v",
      QUICKNES_USE_OVERSCAN_V_LABEL_VN,
      NULL,
      QUICKNES_USE_OVERSCAN_V_INFO_0_VN,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
#endif
   {
      "quicknes_palette",
      QUICKNES_PALETTE_LABEL_VN,
      NULL,
      QUICKNES_PALETTE_INFO_0_VN,
      NULL,
      NULL,
      {
         { "default",              OPTION_VAL_DEFAULT_VN },
         { "asqrealc",             OPTION_VAL_ASQREALC_VN },
         { "nintendo-vc",          OPTION_VAL_NINTENDO_VC_VN },
         { "rgb",                  OPTION_VAL_RGB_VN },
         { "yuv-v3",               OPTION_VAL_YUV_V3_VN },
         { "unsaturated-final",    OPTION_VAL_UNSATURATED_FINAL_VN },
         { "sony-cxa2025as-us",    OPTION_VAL_SONY_CXA2025AS_US_VN },
         { "pal",                  OPTION_VAL_PAL_VN },
         { "bmf-final2",           OPTION_VAL_BMF_FINAL2_VN },
         { "bmf-final3",           OPTION_VAL_BMF_FINAL3_VN },
         { "smooth-fbx",           OPTION_VAL_SMOOTH_FBX_VN },
         { "composite-direct-fbx", OPTION_VAL_COMPOSITE_DIRECT_FBX_VN },
         { "pvm-style-d93-fbx",    OPTION_VAL_PVM_STYLE_D93_FBX_VN },
         { "ntsc-hardware-fbx",    OPTION_VAL_NTSC_HARDWARE_FBX_VN },
         { "nes-classic-fbx-fs",   OPTION_VAL_NES_CLASSIC_FBX_FS_VN },
         { "nescap",               OPTION_VAL_NESCAP_VN },
         { "wavebeam",             OPTION_VAL_WAVEBEAM_VN },
         { NULL, NULL},
      },
      "default",
   },
   {
      "quicknes_no_sprite_limit",
      QUICKNES_NO_SPRITE_LIMIT_LABEL_VN,
      NULL,
      QUICKNES_NO_SPRITE_LIMIT_INFO_0_VN,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   {
      "quicknes_audio_nonlinear",
      QUICKNES_AUDIO_NONLINEAR_LABEL_VN,
      NULL,
      QUICKNES_AUDIO_NONLINEAR_INFO_0_VN,
      NULL,
      NULL,
      {
         { "nonlinear",      OPTION_VAL_NONLINEAR_VN },
         { "linear",         OPTION_VAL_LINEAR_VN },
         { "stereo panning", OPTION_VAL_STEREO_PANNING_VN },
         { NULL, NULL },
      },
      "nonlinear",
   },
   {
      "quicknes_audio_eq",
      QUICKNES_AUDIO_EQ_LABEL_VN,
      NULL,
      QUICKNES_AUDIO_EQ_INFO_0_VN,
      NULL,
      NULL,
      {
         { "default", OPTION_VAL_DEFAULT_VN },
         { "famicom", OPTION_VAL_FAMICOM_VN },
         { "tv",      OPTION_VAL_TV_VN },
         { "flat",    OPTION_VAL_FLAT_VN },
         { "crisp",   OPTION_VAL_CRISP_VN },
         { "tinny",   OPTION_VAL_TINNY_VN },
         { NULL, NULL },
      },
      "default",
   },
   {
      "quicknes_turbo_enable",
      QUICKNES_TURBO_ENABLE_LABEL_VN,
      NULL,
      QUICKNES_TURBO_ENABLE_INFO_0_VN,
      NULL,
      NULL,
      {
         { "none",     OPTION_VAL_NONE_VN },
         { "player 1", OPTION_VAL_PLAYER_1_VN },
         { "player 2", OPTION_VAL_PLAYER_2_VN },
         { "both",     OPTION_VAL_BOTH_VN },
         { NULL, NULL },
      },
      "none",
   },
   {
      "quicknes_turbo_pulse_width",
      QUICKNES_TURBO_PULSE_WIDTH_LABEL_VN,
      NULL,
      QUICKNES_TURBO_PULSE_WIDTH_INFO_0_VN,
      NULL,
      NULL,
      {
         { "1",  NULL },
         { "2",  NULL },
         { "3",  NULL },
         { "5",  NULL },
         { "10", NULL },
         { "15", NULL },
         { "30", NULL },
         { "60", NULL },
         { NULL, NULL },
      },
      "3",
   },
   {
      "quicknes_up_down_allowed",
      QUICKNES_UP_DOWN_ALLOWED_LABEL_VN,
      NULL,
      QUICKNES_UP_DOWN_ALLOWED_INFO_0_VN,
      NULL,
      NULL,
      {
         { "disabled", NULL },
         { "enabled",  NULL },
         { NULL, NULL },
      },
      "disabled",
   },
   { NULL, NULL, NULL, NULL, NULL, NULL, {{0}}, NULL },
};
struct retro_core_options_v2 options_vn = {
   option_cats_vn,
   option_defs_vn
};


#ifdef __cplusplus
}
#endif

#endif