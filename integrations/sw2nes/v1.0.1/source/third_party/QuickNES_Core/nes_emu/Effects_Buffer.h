
// Multi-channel effects buffer with panning, echo and reverb

// Game_Music_Emu 0.3.0

#ifndef EFFECTS_BUFFER_H
#define EFFECTS_BUFFER_H

#include <stdint.h>
#include "Multi_Buffer.h"

// Effects_Buffer uses several buffers and outputs stereo sample pairs.
class Effects_Buffer : public Multi_Buffer {
public:
	// If center_only is true, only center buffers are created and
	// less memory is used.
	Effects_Buffer( bool center_only = false );
	
	// Channel  Effect    Center Pan
	// ---------------------------------
	//    0,5    reverb       pan_1
	//    1,6    reverb       pan_2
	//    2,7    echo         -
	//    3      echo         -
	//    4      echo         -
	
	// Fixed-point type for pan/level coefficients (Q15).
	typedef long fixed_t;
	
	// Channel configuration. Levels/pans are Q15 fixed-point (1.0 == 1<<15,
	// i.e. the former TO_FIXED() value); delays are integer milliseconds. This
	// keeps the whole effects path integer and deterministic.
	struct config_t {
		fixed_t pan_1;          // Q15: 0 = center, <0 = left, >0 = right
		fixed_t pan_2;
		int     echo_delay;     // msec
		fixed_t echo_level;     // Q15, 0..1<<15
		int     reverb_delay;   // msec
		int     delay_variance; // difference between left/right delays (msec)
		fixed_t reverb_level;   // Q15, 0..1<<15
		bool effects_enabled;   // if false, use optimized simple mixer
		config_t();
	};
	
	// Set configuration of buffer
	virtual void config( const config_t& );
	void set_depth( int depth_q15 ); // Q15 depth (1<<15 == 1.0)
	
public:
	~Effects_Buffer();
	const char *set_sample_rate( long samples_per_sec, int msec = blip_default_length );
	void clock_rate( long );
	void bass_freq( int );
	void clear();
	channel_t channel( int );
	void end_frame( blip_time_t, bool was_stereo = true );
	long read_samples( blip_sample_t*, long );
	long samples_avail() const;
private:
	
	enum { max_buf_count = 7 };
	Blip_Buffer bufs [max_buf_count];
	enum { chan_count = 5 };
	channel_t channels [chan_count];
	config_t config_;
	long stereo_remain;
	long effect_remain;
	int buf_count;
	bool effects_enabled;
	
	blip_sample_t* reverb_buf;
	blip_sample_t* echo_buf;
	int reverb_pos;
	int echo_pos;

	// Snapshot buffers for SaveAudioBufferState / RestoreAudioBufferState.
	// Allocated alongside echo_buf / reverb_buf in set_sample_rate, same
	// sizes. Effects_Buffer is the only Multi_Buffer subclass with internal
	// delay lines beyond the Blip_Buffers themselves, so it needs to
	// snapshot them or runahead audio with effects enabled corrupts after
	// every restore.
	blip_sample_t* extra_echo_buf;
	blip_sample_t* extra_reverb_buf;
	int extra_echo_pos;
	int extra_reverb_pos;
	bool extra_valid;

	struct {
		fixed_t pan_1_levels [2];
		fixed_t pan_2_levels [2];
		int echo_delay_l;
		int echo_delay_r;
		fixed_t echo_level;
		int reverb_delay_l;
		int reverb_delay_r;
		fixed_t reverb_level;
	} chans;
	
	void mix_mono( blip_sample_t*, long );
	void mix_stereo( blip_sample_t*, long );
	void mix_enhanced( blip_sample_t*, long );
	void mix_mono_enhanced( blip_sample_t*, long );
public:
	virtual void SaveAudioBufferState();
	virtual void RestoreAudioBufferState();
};

	inline Effects_Buffer::channel_t Effects_Buffer::channel( int i ) {
		return channels [i % chan_count];
	}
	
#endif
