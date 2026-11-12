/* Validation harness for the emu2413 table bake.
 *
 * Runtime consistency check for the baked path: fingerprints every derived
 * table and checksums a calc sweep that exercises the FM, EG, PM/AM and key
 * on/off paths. The float reference that produced the baked tables now lives in
 * tools/gen_emu2413_tables.cpp; a byte-diff of its output against
 * emu2413_tables.h is the bake check.
 */
#include <cstdio>
#include <cstring>
#include "emu2413.h"

/* FNV-1a over arbitrary bytes: a compact, order-sensitive table fingerprint. */
static unsigned long long fnv(const void* p, size_t n, unsigned long long h)
{
	const unsigned char* b = (const unsigned char*)p;
	for (size_t i = 0; i < n; i++) { h ^= b[i]; h *= 1099511628211ULL; }
	return h;
}

int main(void)
{
	OPLL* o = OPLL_new(3579545);

	/* (1) Fingerprint every baked/derived table member directly. */
	unsigned long long h = 1469598103934665603ULL;
	h = fnv(o->AR_ADJUST_TABLE, sizeof o->AR_ADJUST_TABLE, h);
	h = fnv(o->DB2LIN_TABLE,    sizeof o->DB2LIN_TABLE,    h);
	h = fnv(o->fullsintable,    sizeof o->fullsintable,    h);
	h = fnv(o->halfsintable,    sizeof o->halfsintable,    h);
	h = fnv(o->pmtable,         sizeof o->pmtable,         h);
	h = fnv(o->amtable,         sizeof o->amtable,         h);
	h = fnv(o->tllTable,        sizeof o->tllTable,        h);
	h = fnv(o->dphaseARTable,   sizeof o->dphaseARTable,   h);
	h = fnv(o->dphaseDRTable,   sizeof o->dphaseDRTable,   h);
	h = fnv(&o->pm_dphase,      sizeof o->pm_dphase,       h);
	h = fnv(&o->am_dphase,      sizeof o->am_dphase,       h);
	std::printf("tables_fnv=%016llx\n", h);

	/* (2) Output sweep: program a spread of instruments / fnums / blocks /
	 * volumes across all 9 channels, key on, run the synth, key off, run more.
	 * Checksum the full int16 stream so any divergence in the calc path (not
	 * just the tables) is caught. */
	unsigned long long oh = 1469598103934665603ULL;
	for (int inst = 0; inst < 16; inst++)
	{
		OPLL_reset(o);
		for (int ch = 0; ch < 9; ch++)
		{
			int fnum  = 100 + ch * 97 + inst * 13;
			int block = (ch + inst) & 7;
			OPLL_writeReg(o, 0x10 + ch, fnum & 0xff);
			OPLL_writeReg(o, 0x20 + ch, 0x10 | ((block & 7) << 1) | ((fnum >> 8) & 1)); /* key on */
			OPLL_writeReg(o, 0x30 + ch, ((inst & 0xf) << 4) | (ch & 0xf));              /* inst|vol */
		}
		for (int s = 0; s < 4096; s++)
		{
			e_int16 v = OPLL_calc(o);
			oh = fnv(&v, sizeof v, oh);
		}
		/* Key off all channels and run the release tail. */
		for (int ch = 0; ch < 9; ch++)
		{
			int fnum  = 100 + ch * 97 + inst * 13;
			int block = (ch + inst) & 7;
			OPLL_writeReg(o, 0x20 + ch, ((block & 7) << 1) | ((fnum >> 8) & 1)); /* key off */
		}
		for (int s = 0; s < 2048; s++)
		{
			e_int16 v = OPLL_calc(o);
			oh = fnv(&v, sizeof v, oh);
		}
	}
	std::printf("output_fnv=%016llx\n", oh);

	OPLL_delete(o);
	return 0;
}
