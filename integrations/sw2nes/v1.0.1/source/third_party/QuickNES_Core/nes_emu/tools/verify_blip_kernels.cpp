/* Validation: compile twice and diff.
/* Validation of the baked runtime path (build with -DBLIP_KERNEL_TEST).
 * treble_eq loads baked kernels; the float reference is tools/gen_blip_kernels.cpp.
 * Both expose the regen accessors. The FNV over every synth's impulses[]
 * across all 48 combos -- after treble_eq and again after a volume() rescale --
 * must match exactly.
 */
#include <cstdio>
#include "Blip_Buffer.h"

static unsigned long long fnv(const void* p, int nbytes, unsigned long long h)
{
	const unsigned char* b = (const unsigned char*)p;
	for (int i = 0; i < nbytes; i++) { h ^= b[i]; h *= 1099511628211ULL; }
	return h;
}

struct Eq { int treble; long rolloff; };
static Eq   eqs[6]   = { {-1,80},{-15,80},{-12,180},{0,1},{5,1},{-47,2000} };
static long rates[4] = { 32000, 44100, 48000, 96000 };

template<int Q>
static unsigned long long sweep(unsigned long long h)
{
	for (int e = 0; e < 6; e++)
	for (int r = 0; r < 4; r++)
	{
		blip_eq_t eq( eqs[e].treble, eqs[e].rolloff, rates[r] );

		Blip_Synth<Q,1> s1;
		s1.treble_eq( eq );
		h = fnv( s1.regen_impulses(), s1.regen_size() * (int)sizeof(short), h );

		/* Exercise the shared volume rescale path. 32768 in Q30 gives
		 * new_unit = 1/32768 -> factor 1.0 -> one kernel-shift + adjust_impulse. */
		Blip_Synth<Q,1> s2;
		s2.volume( 32768 );
		s2.treble_eq( eq );
		h = fnv( s2.regen_impulses(), s2.regen_size() * (int)sizeof(short), h );
	}
	return h;
}

int main(void)
{
	unsigned long long h = 1469598103934665603ULL;
	h = sweep<8>(h);
	h = sweep<12>(h);
	std::printf("impulses_fnv=%016llx\n", h);
	return 0;
}
