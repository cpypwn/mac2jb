
// NES cartridge data (PRG, CHR, mapper)

// Nes_Emu 0.7.0

#ifndef NES_CART_H
#define NES_CART_H

#include <stdint.h>
#include "blargg_common.h"
#include "abstract_file.h"

class Nes_Cart {
public:
	Nes_Cart();
	~Nes_Cart();
	
	// Load iNES file
	const char * load_ines( Auto_File_Reader );
	static const char not_ines_file [];
	
	// to do: support UNIF?
	
	// True if data is currently loaded
	bool loaded() const { return prg_ != NULL; }
	
	// Free data
	void clear();
	
	// True if cartridge claims to have battery-backed memory
	bool has_battery_ram() const;
	
	// Size of PRG data
	long prg_size() const { return prg_size_; }
	
	// Size of CHR data
	long chr_size() const { return chr_size_; }
	
	// Change size of PRG (code) data
	const char * resize_prg( long );
	
	// Change size of CHR (graphics) data 
	const char * resize_chr( long );
	
	// Set mapper and information bytes. LSB and MSB are the standard iNES header
	// bytes at offsets 6 and 7.
	void set_mapper( int mapper_lsb, int mapper_msb );
	
	unsigned mapper_data() const { return mapper; }
	
	// Initial mirroring setup
	int mirroring() const { return mapper & 0x09; }
	
	// iNES mapper code
	int mapper_code() const;
	
	// Pointer to beginning of PRG data
	uint8_t      * prg()       { return prg_; }
	uint8_t const* prg() const { return prg_; }
	
	// Pointer to beginning of CHR data
	uint8_t      * chr()       { return chr_; }
	uint8_t const* chr() const { return chr_; }
	
	// End of public interface
private:
	enum { bank_size = 8 * 1024L }; // bank sizes must be a multiple of this
	uint8_t *prg_;
	uint8_t *chr_;
	long prg_size_;
	long chr_size_;
	unsigned mapper;
	long round_to_bank_size( long n );
};

inline bool Nes_Cart::has_battery_ram() const { return mapper & 0x02; }

inline void Nes_Cart::set_mapper( int mapper_lsb, int mapper_msb )
{
	mapper = mapper_msb * 0x100 + mapper_lsb;
}

inline int Nes_Cart::mapper_code() const { return ((mapper >> 8) & 0xf0) | ((mapper >> 4) & 0x0f); }

#endif
