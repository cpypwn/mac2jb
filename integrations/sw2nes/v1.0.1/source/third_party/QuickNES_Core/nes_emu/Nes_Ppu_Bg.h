while ( true )
{
	while ( count-- )
	{
#ifdef BG_EXGRAFIX
		// MMC5 extended-attribute mode: the per-tile ExRAM byte supplies both
		// the 4 KiB CHR bank and the 2-bit palette for this background tile.
		int const exbyte = exgrafix_exram [addr & 0x3ff];
		unsigned long offset = (exbyte >> 6 & 3) * attrib_factor + this->palette_offset;
		cache_t const* lines = this->get_bg_tile_ex( exbyte, nametable [addr] );
#else
		int attrib = attr_table [addr >> 2 & 0x07];
		attrib >>= (addr >> 4 & 4) | (addr & 2);
		unsigned long offset = (attrib & 3) * attrib_factor + this->palette_offset;
		
		// draw one tile
		cache_t const* lines = this->get_bg_tile( nametable [addr] + bg_bank );
#endif
		uint8_t* p = pixels;
		addr++;
		pixels += 8; // next tile
		
		if ( !clipped )
		{
			// optimal case: no clipping
			for ( int n = 4; n--; )
			{
				unsigned long line = *lines++;
				BG_STORE( p, 0, (line >> 4 & mask) + offset );
				BG_STORE( p, 1, (line      & mask) + offset );
				p += row_bytes;
				BG_STORE( p, 0, (line >> 6 & mask) + offset );
				BG_STORE( p, 1, (line >> 2 & mask) + offset );
				p += row_bytes;
			}
		}
		else
		{
			lines += fine_y >> 1;
			
			if ( fine_y & 1 )
			{
				unsigned long line = *lines++;
				BG_STORE( p, 0, (line >> 6 & mask) + offset );
				BG_STORE( p, 1, (line >> 2 & mask) + offset );
				p += row_bytes;
			}
			
			for ( int n = height >> 1; n--; )
			{
				unsigned long line = *lines++;
				BG_STORE( p, 0, (line >> 4 & mask) + offset );
				BG_STORE( p, 1, (line      & mask) + offset );
				p += row_bytes;
				BG_STORE( p, 0, (line >> 6 & mask) + offset );
				BG_STORE( p, 1, (line >> 2 & mask) + offset );
				p += row_bytes;
			}
			
			if ( height & 1 )
			{
				unsigned long line = *lines;
				BG_STORE( p, 0, (line >> 4 & mask) + offset );
				BG_STORE( p, 1, (line      & mask) + offset );
			}
		} 
	}
	
	count = count2;
	count2 = 0;
	addr -= 32;
	attr_table = attr_table - nametable + nametable2;
	nametable = nametable2;
	if ( !count )
		break;
}
