
// Nes_Emu 0.7.0. http://www.slack.net/~ant/

#include "Nes_Mapper.h"

#include <cstdio>
#include <string.h>
#include "Nes_Core.h"

/* Copyright (C) 2004-2006 Shay Green. This module is free software; you
can redistribute it and/or modify it under the terms of the GNU Lesser
General Public License as published by the Free Software Foundation; either
version 2.1 of the License, or (at your option) any later version. This
module is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for
more details. You should have received a copy of the GNU Lesser General
Public License along with this module; if not, write to the Free Software
Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA 02111-1307 USA */

#include "blargg_source.h"

/*
  New mapping distribution by Sergio Martin (eien86)
  https://github.com/SergioMartin86/jaffarPlus
*/
#include "mappers/mapper000.hpp"
#include "mappers/mapper001.hpp"
#include "mappers/mapper002.hpp"
#include "mappers/mapper003.hpp"
#include "mappers/mapper004.hpp"
#include "mappers/mapper005.hpp"
#include "mappers/mapper007.hpp"
#include "mappers/mapper009.hpp"
#include "mappers/mapper010.hpp"
#include "mappers/mapper011.hpp"
#include "mappers/mapper015.hpp"
#include "mappers/mapper019.hpp"
#include "mappers/mapper021.hpp"
#include "mappers/mapper022.hpp"
#include "mappers/mapper023.hpp"
#include "mappers/mapper024.hpp"
#include "mappers/mapper025.hpp"
#include "mappers/mapper026.hpp"
#include "mappers/mapper030.hpp"
#include "mappers/mapper032.hpp"
#include "mappers/mapper033.hpp"
#include "mappers/mapper034.hpp"
#include "mappers/mapper060.hpp"
#include "mappers/mapper066.hpp"
#include "mappers/mapper069.hpp"
#include "mappers/mapper070.hpp"
#include "mappers/mapper071.hpp"
#include "mappers/mapper073.hpp"
#include "mappers/mapper075.hpp"
#include "mappers/mapper078.hpp"
#include "mappers/mapper079.hpp"
#include "mappers/mapper085.hpp"
#include "mappers/mapper086.hpp"
#include "mappers/mapper087.hpp"
#include "mappers/mapper088.hpp"
#include "mappers/mapper089.hpp"
#include "mappers/mapper093.hpp"
#include "mappers/mapper094.hpp"
#include "mappers/mapper097.hpp"
#include "mappers/mapper113.hpp"
#include "mappers/mapper140.hpp"
#include "mappers/mapper152.hpp"
#include "mappers/mapper154.hpp"
#include "mappers/mapper156.hpp"
#include "mappers/mapper180.hpp"
#include "mappers/mapper184.hpp"
#include "mappers/mapper190.hpp"
#include "mappers/mapper193.hpp"
#include "mappers/mapper206.hpp"
#include "mappers/mapper207.hpp"
#include "mappers/mapper232.hpp"
#include "mappers/mapper240.hpp"
#include "mappers/mapper241.hpp"
#include "mappers/mapper244.hpp"
#include "mappers/mapper246.hpp"

Nes_Mapper::Nes_Mapper()
{
	emu_ = NULL;
	static char c;
	state = &c; // TODO: state must not be null?
	state_size = 0;
}

Nes_Mapper::~Nes_Mapper()
{
}

// Sets mirroring, maps first 8K CHR in, first and last 16K of PRG,
// intercepts writes to upper half of memory, and clears registered state.
void Nes_Mapper::default_reset_state()
{
	int mirroring = cart_->mirroring();
	if ( mirroring & 8 )
		mirror_full();
	else if ( mirroring & 1 )
		mirror_vert();
	else
		mirror_horiz();
	
	set_chr_bank( 0, bank_8k, 0 );
	
	set_prg_bank( 0x8000, bank_16k, 0 );
	set_prg_bank( 0xC000, bank_16k, last_bank );
	
	intercept_writes( 0x8000, 0x8000 );
	
	memset( state, 0, state_size );
}

void Nes_Mapper::reset()
{
	default_reset_state();
	reset_state();
	apply_mapping();
}

void mapper_state_t::write( const void* p, unsigned long s )
{
	size = s;
	memcpy( data, p, s );
}

int mapper_state_t::read( void* p, unsigned long s ) const
{
	if ( (long) s > size )
		s = size;
	memcpy( p, data, s );
	return s;
}

void Nes_Mapper::save_state( mapper_state_t& out )
{
	out.write( state, state_size );
}

void Nes_Mapper::load_state( mapper_state_t const& in )
{
	default_reset_state();
	read_state( in );
	apply_mapping();
}

void Nes_Mapper::read_state( mapper_state_t const& in )
{
	memset( state, 0, state_size );
	in.read( state, state_size );
	apply_mapping();
}

// Timing

void Nes_Mapper::irq_changed() { emu_->irq_changed(); }
	
nes_time_t Nes_Mapper::next_irq( nes_time_t ) { return no_irq; }

void Nes_Mapper::a12_clocked() { }

void Nes_Mapper::run_until( nes_time_t ) { }

void Nes_Mapper::end_frame( nes_time_t ) { }

bool Nes_Mapper::ppu_enabled() const { return emu().ppu.w2001 & 0x08; }

// Sound

int Nes_Mapper::channel_count() const { return 0; }

void Nes_Mapper::set_channel_buf( int, Blip_Buffer* ) { }

void Nes_Mapper::set_treble( blip_eq_t const& ) { }

// Memory mapping

void Nes_Mapper::set_prg_bank( nes_addr_t addr, bank_size_t bs, int bank )
{
	int bank_size = 1 << bs;
	
	int bank_count = cart_->prg_size() >> bs;
	if ( bank < 0 )
		bank += bank_count;
	
	if ( bank >= bank_count )
		bank %= bank_count;
	
	emu().map_code( addr, bank_size, cart_->prg() + (bank << bs) );
	
	if ( unsigned (addr - 0x6000) < 0x2000 )
		emu().enable_prg_6000();
}

void Nes_Mapper::set_chr_bank( nes_addr_t addr, bank_size_t bs, int bank )
{
	emu().ppu.render_until( emu().clock() ); 
	emu().ppu.set_chr_bank( addr, 1 << bs, bank << bs );
}

void Nes_Mapper::set_chr_bank_ex( nes_addr_t addr, bank_size_t bs, int bank )
{
	emu().ppu.render_until( emu().clock() ); 
	emu().ppu.set_chr_bank_ex( addr, 1 << bs, bank << bs );
}

void Nes_Mapper::set_exgrafix( uint8_t const* exram, int chr_high )
{
	emu().ppu.render_until( emu().clock() );
	emu().ppu.set_exgrafix( exram, chr_high );
}

void Nes_Mapper::mirror_manual( int page0, int page1, int page2, int page3 )
{
	emu().ppu.render_bg_until( emu().clock() ); 
	emu().ppu.set_nt_banks( page0, page1, page2, page3 );
}

#ifndef NDEBUG
int Nes_Mapper::handle_bus_conflict( nes_addr_t addr, int data )
{
	return data;
}
#endif


Nes_Mapper* Nes_Mapper::create( Nes_Cart const* cart, Nes_Core* emu )
{
  // Getting cartdrige mapper code
  int mapperCode = cart->mapper_code();
	
  // Storage for the mapper, NULL by default	
  Nes_Mapper* mapper = NULL;

  // Now checking if the detected mapper code is supported. A switch
  // is faster than the old if-chain (which paid for every comparison
  // unconditionally on every cart load) and guards against the silent
  // footgun where two entries for the same mapperCode would have both
  // executed -- the second would have leaked the first.
  switch ( mapperCode )
  {
    case   0: mapper = new Mapper000(); break;
    case   1: mapper = new Mapper001(); break;
    case   2: mapper = new Mapper002(); break;
    case   3: mapper = new Mapper003(); break;
    case   4: mapper = new Mapper004(); break;
    case   5: mapper = new Mapper005(); break;
    case   7: mapper = new Mapper007(); break;
    case   9: mapper = new Mapper009(); break;
    case  10: mapper = new Mapper010(); break;
    case  11: mapper = new Mapper011(); break;
    case  15: mapper = new Mapper015(); break;
    case  19: mapper = new Mapper019(); break;
    case  21: mapper = new Mapper021(); break;
    case  22: mapper = new Mapper022(); break;
    case  23: mapper = new Mapper023(); break;
    case  24: mapper = new Mapper024(); break;
    case  25: mapper = new Mapper025(); break;
    case  26: mapper = new Mapper026(); break;
    case  30: mapper = new Mapper030(); break;
    case  32: mapper = new Mapper032(); break;
    case  33: mapper = new Mapper033(); break;
    case  34: mapper = new Mapper034(); break;
    case  60: mapper = new Mapper060(); break;
    case  66: mapper = new Mapper066(); break;
    case  69: mapper = new Mapper069(); break;
    case  70: mapper = new Mapper070(); break;
    case  71: mapper = new Mapper071(); break;
    case  73: mapper = new Mapper073(); break;
    case  75: mapper = new Mapper075(); break;
    case  78: mapper = new Mapper078(); break;
    case  79: mapper = new Mapper079(); break;
    case  85: mapper = new Mapper085(); break;
    case  86: mapper = new Mapper086(); break;
    case  87: mapper = new Mapper087(); break;
    case  88: mapper = new Mapper088(); break;
    case  89: mapper = new Mapper089(); break;
    case  93: mapper = new Mapper093(); break;
    case  94: mapper = new Mapper094(); break;
    case  97: mapper = new Mapper097(); break;
    case 113: mapper = new Mapper113(); break;
    case 140: mapper = new Mapper140(); break;
    case 152: mapper = new Mapper152(); break;
    case 154: mapper = new Mapper154(); break;
    case 156: mapper = new Mapper156(); break;
    case 180: mapper = new Mapper180(); break;
    case 184: mapper = new Mapper184(); break;
    case 190: mapper = new Mapper190(); break;
    case 193: mapper = new Mapper193(); break;
    case 206: mapper = new Mapper206(); break;
    case 207: mapper = new Mapper207(); break;
    case 232: mapper = new Mapper232(); break;
    case 240: mapper = new Mapper240(); break;
    case 241: mapper = new Mapper241(); break;
    case 244: mapper = new Mapper244(); break;
    case 246: mapper = new Mapper246(); break;
    default: break;
  }

  // If no mapper was found, return null (error) now 
  if (mapper == NULL)
  {
	fprintf(stderr, "Could not find mapper for code: %u\n", mapperCode);
    return NULL;
  } 

  // Assigning backwards pointers to cartdrige and emulator now
  mapper->cart_ = cart;
  mapper->emu_ = emu;

  // Returning successfully created mapper
  return mapper;
}
