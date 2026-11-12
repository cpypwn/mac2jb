/* Generator for emu2413_tables.h (offline / not part of the library build).
 *
 * Holds the reference floating-point table builders (log/pow/sin/log10 damped
 * sine, dB curves, TLL and PM/AM tables) that used to live in emu2413.cpp under
 * EMU2413_REGEN_TABLES. Moved here so the emulator itself is free of floating
 * point; this tool is the sole float reference and the deterministic source of
 * emu2413_tables.h for all platforms.
 *
 * These tables are transcendental, so a fixed-point rewrite cannot reproduce
 * them bit-exactly; they are baked once here (in double) and shipped as
 * integers. Baked at the fixed NES OPLL clock (3579545 Hz), the only clock
 * QuickNES uses.
 *
 * Regenerate:
 *   g++ -O2 -o gen tools/gen_emu2413_tables.cpp && ./gen > ../emu2413_tables.h
 */
#include <cstdio>
#include <cstring>
#include <cmath>
#include "emu2413.h"

/* Tuning constants that were private to emu2413.cpp. */
#define DB2LIN_AMP_BITS 11
#define EG_DP_BITS      22
#define PM_AMP_BITS     8
#define PM_AMP          (1 << PM_AMP_BITS)
#define PM_SPEED        6.4
#define PM_DEPTH        13.75
#define AM_SPEED        3.7
#define AM_DEPTH        2.4
#define TL2EG(d)        ((d)*(e_int32)(TL_STEP/EG_STEP))

INLINE static e_int32 Min (e_int32 i, e_int32 j)
{
  if (i < j)
    return i;
  else
    return j;
}

/* Table for AR to LogCurve. */
static void makeAdjustTable (OPLL * opll)
{
  e_int32 i;

  opll->AR_ADJUST_TABLE[0] = (1 << EG_BITS);
  for (i = 1; i < 128; i++)
    opll->AR_ADJUST_TABLE[i] = (e_uint16) ((double) (1 << EG_BITS) - 1 - (1 << EG_BITS) * log ((double)i) / log (128.));
}


/* Table for dB(0 -- (1<<DB_BITS)-1) to Liner(0 -- DB2LIN_AMP_WIDTH) */
static void makeDB2LinTable (OPLL * opll)
{
  e_int32 i;

  for (i = 0; i < DB_MUTE + DB_MUTE; i++)
  {
    opll->DB2LIN_TABLE[i] = (e_int16) ((double) ((1 << DB2LIN_AMP_BITS) - 1) * powf(10, -(double) i * DB_STEP / 20));
    if (i >= DB_MUTE) opll->DB2LIN_TABLE[i] = 0;
    opll->DB2LIN_TABLE[i + DB_MUTE + DB_MUTE] = (e_int16) (-opll->DB2LIN_TABLE[i]);
  }
}

/* Liner(+0.0 - +1.0) to dB((1<<DB_BITS) - 1 -- 0) */
static e_int32 lin2db (double d)
{
  if (d == 0)
    return (DB_MUTE - 1);
  return Min (-(e_int32) (20.0 * log10 (d) / DB_STEP), DB_MUTE-1);  /* 0 -- 127 */
}


/* Sin Table */
static void makeSinTable (OPLL * opll)
{
  e_int32 i;

  for (i = 0; i < PG_WIDTH / 4; i++)
  {
    opll->fullsintable[i] = (e_uint32) lin2db (sin (2.0 * PI * i / PG_WIDTH) );
  }

  for (i = 0; i < PG_WIDTH / 4; i++)
  {
    opll->fullsintable[PG_WIDTH / 2 - 1 - i] = opll->fullsintable[i];
  }

  for (i = 0; i < PG_WIDTH / 2; i++)
  {
    opll->fullsintable[PG_WIDTH / 2 + i] = (e_uint32) (DB_MUTE + DB_MUTE + opll->fullsintable[i]);
  }

  for (i = 0; i < PG_WIDTH / 2; i++)
    opll->halfsintable[i] = opll->fullsintable[i];
  for (i = PG_WIDTH / 2; i < PG_WIDTH; i++)
    opll->halfsintable[i] = opll->fullsintable[0];
}

/* Table for Pitch Modulator */
static void makePmTable (OPLL * opll)
{
  e_int32 i;

  for (i = 0; i < PM_PG_WIDTH; i++)
    opll->pmtable[i] = (e_int32) ((double) PM_AMP * powf(2, (double) PM_DEPTH * sin (2.0 * PI * i / PM_PG_WIDTH) / 1200));
}

/* Table for Amp Modulator */
static void makeAmTable (OPLL * opll)
{
  e_int32 i;

  for (i = 0; i < AM_PG_WIDTH; i++)
    opll->amtable[i] = (e_int32) ((double) AM_DEPTH / 2 / DB_STEP * (1.0 + sin (2.0 * PI * i / PM_PG_WIDTH)));
}

static void makeTllTable (OPLL *opll)
{
#define dB2(x) ((x)*2)

  static const double kltable[16] = {
    dB2 (0.000), dB2 (9.000), dB2 (12.000), dB2 (13.875), dB2 (15.000), dB2 (16.125), dB2 (16.875), dB2 (17.625),
    dB2 (18.000), dB2 (18.750), dB2 (19.125), dB2 (19.500), dB2 (19.875), dB2 (20.250), dB2 (20.625), dB2 (21.000)
  };

  e_int32 tmp;
  e_int32 fnum, block, TL, KL;

  for (fnum = 0; fnum < 16; fnum++)
    for (block = 0; block < 8; block++)
      for (TL = 0; TL < 64; TL++)
        for (KL = 0; KL < 4; KL++)
        {
          if (KL == 0)
          {
            opll->tllTable[fnum][block][TL][KL] = TL2EG (TL);
          }
          else
          {
            tmp = (e_int32) (kltable[fnum] - dB2 (3.000) * (7 - block));
            if (tmp <= 0)
              opll->tllTable[fnum][block][TL][KL] = TL2EG (TL);
            else
              opll->tllTable[fnum][block][TL][KL] = (e_uint32) ((tmp >> (3 - KL)) / EG_STEP) + TL2EG (TL);
          }
        }
}

#ifdef USE_SPEC_ENV_SPEED
static const double attacktime[16][4] = {
  {0, 0, 0, 0},
  {1730.15, 1400.60, 1153.43, 988.66},
  {865.08, 700.30, 576.72, 494.33},
  {432.54, 350.15, 288.36, 247.16},
  {216.27, 175.07, 144.18, 123.58},
  {108.13, 87.54, 72.09, 61.79},
  {54.07, 43.77, 36.04, 30.90},
  {27.03, 21.88, 18.02, 15.45},
  {13.52, 10.94, 9.01, 7.72},
  {6.76, 5.47, 4.51, 3.86},
  {3.38, 2.74, 2.25, 1.93},
  {1.69, 1.37, 1.13, 0.97},
  {0.84, 0.70, 0.60, 0.54},
  {0.50, 0.42, 0.34, 0.30},
  {0.28, 0.22, 0.18, 0.14},
  {0.00, 0.00, 0.00, 0.00}
};

static const double decaytime[16][4] = {
  {0, 0, 0, 0},
  {20926.60, 16807.20, 14006.00, 12028.60},
  {10463.30, 8403.58, 7002.98, 6014.32},
  {5231.64, 4201.79, 3501.49, 3007.16},
  {2615.82, 2100.89, 1750.75, 1503.58},
  {1307.91, 1050.45, 875.37, 751.79},
  {653.95, 525.22, 437.69, 375.90},
  {326.98, 262.61, 218.84, 187.95},
  {163.49, 131.31, 109.42, 93.97},
  {81.74, 65.65, 54.71, 46.99},
  {40.87, 32.83, 27.36, 23.49},
  {20.44, 16.41, 13.68, 11.75},
  {10.22, 8.21, 6.84, 5.87},
  {5.11, 4.10, 3.42, 2.94},
  {2.55, 2.05, 1.71, 1.47},
  {1.27, 1.27, 1.27, 1.27}
};
#endif

/* Rate Table for Attack */
static void makeDphaseARTable(OPLL * opll)
{
  e_int32 AR, Rks, RM, RL;
#ifdef USE_SPEC_ENV_SPEED
  e_uint32 attacktable[16][4];

  for (RM = 0; RM < 16; RM++)
    for (RL = 0; RL < 4; RL++)
    {
      if (RM == 0)
        attacktable[RM][RL] = 0;
      else if (RM == 15)
        attacktable[RM][RL] = EG_DP_WIDTH;
      else
        attacktable[RM][RL] = (e_uint32) ((double) (1 << EG_DP_BITS) / (attacktime[RM][RL] * 3579545 / 72000));

    }
#endif

  for (AR = 0; AR < 16; AR++)
    for (Rks = 0; Rks < 16; Rks++)
    {
      RM = AR + (Rks >> 2);
      RL = Rks & 3;
      if (RM > 15)
        RM = 15;
      switch (AR)
      {
      case 0:
        opll->dphaseARTable[AR][Rks] = 0;
        break;
      case 15:
        opll->dphaseARTable[AR][Rks] = 0;/*EG_DP_WIDTH;*/ 
        break;
      default:
#ifdef USE_SPEC_ENV_SPEED
        opll->dphaseARTable[AR][Rks] = (attacktable[RM][RL]);
#else
        opll->dphaseARTable[AR][Rks] = ((3 * (RL + 4) << (RM + 1)));
#endif
        break;
      }
    }
}

/* Rate Table for Decay and Release */
static void makeDphaseDRTable (OPLL * opll)
{
  e_int32 DR, Rks, RM, RL;

#ifdef USE_SPEC_ENV_SPEED
  e_uint32 decaytable[16][4];

  for (RM = 0; RM < 16; RM++)
    for (RL = 0; RL < 4; RL++)
      if (RM == 0)
        decaytable[RM][RL] = 0;
      else
        decaytable[RM][RL] = (e_uint32) ((double) (1 << EG_DP_BITS) / (decaytime[RM][RL] * 3579545 / 72000));
#endif

  for (DR = 0; DR < 16; DR++)
    for (Rks = 0; Rks < 16; Rks++)
    {
      RM = DR + (Rks >> 2);
      RL = Rks & 3;
      if (RM > 15)
        RM = 15;
      switch (DR)
      {
      case 0:
        opll->dphaseDRTable[DR][Rks] = 0;
        break;
      default:
#ifdef USE_SPEC_ENV_SPEED
        opll->dphaseDRTable[DR][Rks] = (decaytable[RM][RL]);
#else
        opll->dphaseDRTable[DR][Rks] = ((RL + 4) << (RM - 1));
#endif
        break;
      }
    }
}

static void dump_u16(const char* name, const e_uint16* p, int n)
{ std::printf("static const e_uint16 %s[%d] = {\n", name, n);
  for (int i = 0; i < n; i++) std::printf("%u,%s", (unsigned)p[i], (i%12==11)?"\n":" ");
  std::printf("\n};\n\n"); }
static void dump_i16(const char* name, const e_int16* p, int n)
{ std::printf("static const e_int16 %s[%d] = {\n", name, n);
  for (int i = 0; i < n; i++) std::printf("%d,%s", (int)p[i], (i%12==11)?"\n":" ");
  std::printf("\n};\n\n"); }
static void dump_i32(const char* name, const e_int32* p, int n)
{ std::printf("static const e_int32 %s[%d] = {\n", name, n);
  for (int i = 0; i < n; i++) std::printf("%d,%s", (int)p[i], (i%10==9)?"\n":" ");
  std::printf("\n};\n\n"); }
static void dump_u32(const char* name, const e_uint32* p, int n)
{ std::printf("static const e_uint32 %s[%d] = {\n", name, n);
  for (int i = 0; i < n; i++) std::printf("%uu,%s", (unsigned)p[i], (i%10==9)?"\n":" ");
  std::printf("\n};\n\n"); }

int main(void)
{
	static OPLL o;
	std::memset(&o, 0, sizeof o);
	o.clk = 3579545;

	/* same order as maketables()/internal_refresh() */
	makePmTable(&o);
	makeAmTable(&o);
	makeDB2LinTable(&o);
	makeAdjustTable(&o);
	makeTllTable(&o);
	makeSinTable(&o);
	makeDphaseARTable(&o);
	makeDphaseDRTable(&o);
	o.pm_dphase = (e_uint32) (PM_SPEED * PM_DP_WIDTH / (o.clk / 72));
	o.am_dphase = (e_uint32) (AM_SPEED * AM_DP_WIDTH / (o.clk / 72));

	std::printf("/* Auto-generated by tools/gen_emu2413_tables.cpp. Do not edit by hand.\n");
	std::printf(" * Baked at the fixed NES OPLL clock (3579545 Hz). Regenerate via the\n");
	std::printf(" * command in that file if any table formula or tuning constant changes. */\n");
	std::printf("#ifndef EMU2413_TABLES_H\n#define EMU2413_TABLES_H\n\n");

	dump_u16("baked_AR_ADJUST_TABLE", o.AR_ADJUST_TABLE, 1 << EG_BITS);
	dump_i16("baked_DB2LIN_TABLE",    o.DB2LIN_TABLE,    (DB_MUTE + DB_MUTE) * 2);
	dump_u16("baked_fullsintable",    o.fullsintable,    PG_WIDTH);
	dump_u16("baked_halfsintable",    o.halfsintable,    PG_WIDTH);
	dump_i32("baked_pmtable",         o.pmtable,         PM_PG_WIDTH);
	dump_i32("baked_amtable",         o.amtable,         AM_PG_WIDTH);
	dump_u32("baked_dphaseARTable",   &o.dphaseARTable[0][0], 16 * 16);
	dump_u32("baked_dphaseDRTable",   &o.dphaseDRTable[0][0], 16 * 16);
	dump_u32("baked_tllTable",        &o.tllTable[0][0][0][0], 16 * 8 * (1 << TL_BITS) * 4);

	std::printf("static const e_uint32 baked_pm_dphase = %uu;\n", (unsigned)o.pm_dphase);
	std::printf("static const e_uint32 baked_am_dphase = %uu;\n\n", (unsigned)o.am_dphase);
	std::printf("#endif /* EMU2413_TABLES_H */\n");
	return 0;
}
