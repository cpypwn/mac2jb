/* Validation for the nonlinearizer DAC bake: recompute the curve in exact
 * 64-bit integer arithmetic and compare against the baked header. Must match.
 *   g++ -O2 -I.. -o v verify_nes_nonlin_table.cpp && ./v
 */
#include <cstdio>
#include <cstdint>
#include <cstring>
#include "nes_nonlin_table.h"

enum { table_bits = 11, table_size = 1 << table_bits };

int main(void)
{
	int16_t ref[table_size];
	int const range = table_size * 3 / 4;
	long long const knum = (long long) 32767 * 13 * 16367 * 202;
	for (int i = 0; i < table_size; i++)
	{
		int j = i - (table_size - range);
		long long out = 0;
		if (j != 0)
		{
			long long num = knum * j;
			long long den = 1000LL * ((long long) 24329 * (range - 1) + (long long) 20200 * j);
			out = num / den;
		}
		ref[j & (table_size - 1)] = (int16_t) out;
	}
	if (memcmp(ref, baked_nonlin_table, sizeof ref) == 0)
	{
		std::printf("nonlin bake: IDENTICAL (%d entries)\n", table_size);
		return 0;
	}
	std::printf("nonlin bake: MISMATCH\n");
	return 1;
}
