
// Abstract file access interfaces

#ifndef ABSTRACT_FILE_H
#define ABSTRACT_FILE_H

#undef BLARGG_CONFIG_H

#include "Data_Reader.h"

// Supports writing
class Data_Writer {
public:
	Data_Writer() { }
	virtual ~Data_Writer() { }
	
	// Write 'n' bytes. NULL on success, otherwise error string.
	virtual const char *write( const void*, long n ) = 0;
	
private:
	// noncopyable
	Data_Writer( const Data_Writer& );
	Data_Writer& operator = ( const Data_Writer& );
};

// Write data to memory
class Mem_Writer : public Data_Writer {
	char* data_;
	long size_;
	long allocated;
	enum { expanding, fixed, ignore_excess } mode;
public:
	// Keep all written data in expanding block of memory
	Mem_Writer();
	
	// Write to fixed-size block of memory. If ignore_excess is false, returns
	// error if more than 'size' data is written, otherwise ignores any excess.
	Mem_Writer( void*, long size, int ignore_excess = 0 );
	
	const char *write( const void*, long );
	
	// Pointer to beginning of written data
	char* data() { return data_; }
	
	// Number of bytes written
	long size() const { return size_; }
	
	~Mem_Writer();
};

// Auto_File to use in place of Data_Reader&/Data_Writer&, allowing a normal
// file path to be used in addition to a Data_Reader/Data_Writer.

class Auto_File_Reader {
public:
	Auto_File_Reader()                      : data(  0 ), path( 0 ) { }
	Auto_File_Reader( Data_Reader& r )      : data( &r ), path( 0 ) { }
	Auto_File_Reader( Auto_File_Reader const& );
	Auto_File_Reader& operator = ( Auto_File_Reader const& );
	~Auto_File_Reader();
	const char* open();
	
	int operator ! () const { return !data; }
	Data_Reader* operator -> () const { return  data; }
	Data_Reader& operator *  () const { return *data; }
private:
	// `data` is mutable so the destructive copy/assignment (see operator=
	// below) can clear the source's pointer through a const reference,
	// which is how this pre-C++11 codebase implements move semantics for
	// temporaries. Earlier versions laundered the write through a
	// const_cast<Auto_File_Reader*>, which is undefined behavior if the
	// source was itself a real const object.
	mutable Data_Reader* data;
	const char* path;
};

class Auto_File_Writer {
public:
	Auto_File_Writer()                      : data(  0 ), path( 0 ) { }
	Auto_File_Writer( Data_Writer& r )      : data( &r ), path( 0 ) { }
	Auto_File_Writer( Auto_File_Writer const& );
	Auto_File_Writer& operator = ( Auto_File_Writer const& );
	~Auto_File_Writer();
	const char* open();
	const char* open_comp( int level = -1 ); // compress output if possible
	
	int operator ! () const { return !data; }
	Data_Writer* operator -> () const { return  data; }
	Data_Writer& operator *  () const { return *data; }
private:
	mutable Data_Writer* data; // see Auto_File_Reader for why this is mutable
	const char* path;
};

inline Auto_File_Reader& Auto_File_Reader::operator = ( Auto_File_Reader const& r )
{
	data = r.data;
	path = r.path;
	r.data = 0; // destructive transfer; `data` is mutable
	return *this;
}
inline Auto_File_Reader::Auto_File_Reader( Auto_File_Reader const& r ) { *this = r; }

inline Auto_File_Writer& Auto_File_Writer::operator = ( Auto_File_Writer const& r )
{
	data = r.data;
	path = r.path;
	r.data = 0; // destructive transfer; `data` is mutable
	return *this;
}
inline Auto_File_Writer::Auto_File_Writer( Auto_File_Writer const& r ) { *this = r; }

#endif
