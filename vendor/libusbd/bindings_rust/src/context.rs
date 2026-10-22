use super::*;

use crate::error::{self, Result};
use std::ffi::CString;
use std::ffi::c_void;
use core::pin::Pin;
use core::future::Future;
use core::task::{Poll};
use std::time::Duration;
use std::{thread};
use std::slice;

// Types/bits
#[non_exhaustive]
pub struct EpDir;

impl EpDir {
    pub const IN: u8 = USB_EP_DIR_IN as u8;
    pub const OUT: u8 = USB_EP_DIR_OUT as u8;
}

#[non_exhaustive]
pub struct EpType;

impl EpType {
    pub const CTRL: u8 = USB_EPATTR_TTYPE_CTRL as u8;
    pub const ISOC: u8 = USB_EPATTR_TTYPE_ISOC as u8;
    pub const BULK: u8 = USB_EPATTR_TTYPE_BULK as u8;
    pub const INTR: u8 = USB_EPATTR_TTYPE_INTR as u8;
}

// Implementation
pub struct Context {
    context: *mut libusbd_ctx_t,
}

impl Drop for Context {
    /// Closes the `libusbd` context.
    fn drop(&mut self) {
        unsafe {
            libusbd_free(self.context);
        }
    }
}

pub struct EpFuture<'a>
{
    context: &'a Context,
    iface_num: u8, 
    ep: u64,
    timeout_ms: u64,
    time_waited: u64,
}

impl Future for EpFuture<'_> 
{
    type Output = Result<i32>;
    fn poll(mut self: Pin<&mut Self>, ctx: &mut core::task::Context<'_>) -> Poll<Self::Output> 
    {
        let result = self.context.ep_transfer_done(self.iface_num, self.ep);
        match result
        {
            Ok(true) => Poll::Ready(self.context.ep_transferred_bytes(self.iface_num, self.ep)),
            Err(f) => Poll::Ready(Err(f)),
            _ => {
                let waker = ctx.waker().clone(); 

                // TODO: should this be more granular?
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(1));
                    waker.wake();
                });
                self.as_mut().time_waited += 1;

                if self.time_waited >= self.timeout_ms {
                    Poll::Ready(Err(error::from_libusbd(libusbd_error_LIBUSBD_TIMEOUT)))
                }
                else {
                    Poll::Pending
                }                
            },
        }
    }
}

impl Context {
    /// Opens a new `libusbd` context.
    pub fn new() -> Result<Self> {

        let mut context = core::mem::MaybeUninit::<*mut libusbd_ctx_t>::uninit();
        let context_state = unsafe {
            match libusbd_init(context.as_mut_ptr()) as i32 {
                err if err < 0 => return Err(error::from_libusbd(err)),
                val => val,
            };
            context.assume_init()
        };

        Ok(Context { context: context_state })
    }

    /// Sets the port's Vendor ID
    pub fn set_vid(&self, val: u16) -> Result<()> {
        try_unsafe!(libusbd_set_vid(self.context, val));

        Ok(())
    }

    /// Sets the port's Product ID
    pub fn set_pid(&self, val: u16) -> Result<()> {
        try_unsafe!(libusbd_set_pid(self.context, val));

        Ok(())
    }

    /// Sets the port's Version
    pub fn set_version(&self, val: u16) -> Result<()> {
        try_unsafe!(libusbd_set_version(self.context, val));

        Ok(())
    }

    /// Sets the port's Class ID
    pub fn set_class(&self, val: u8) -> Result<()> {
        try_unsafe!(libusbd_set_class(self.context, val));

        Ok(())
    }

    /// Sets the port's Subclass ID
    pub fn set_subclass(&self, val: u8) -> Result<()> {
        try_unsafe!(libusbd_set_subclass(self.context, val));

        Ok(())
    }

    /// Sets the port's Protocol ID
    pub fn set_protocol(&self, val: u8) -> Result<()> {
        try_unsafe!(libusbd_set_protocol(self.context, val));

        Ok(())
    }

    /// Sets the port's manufacturer string
    #[allow(temporary_cstring_as_ptr)] // we explicitly copy the string to new memory
    pub fn set_manufacturer_str(&self, val: &str) -> Result<()> {
        try_unsafe!(libusbd_set_manufacturer_str(self.context, CString::new(val).unwrap().as_ptr()));

        Ok(())
    }

    /// Sets the port's product string
    #[allow(temporary_cstring_as_ptr)] // we explicitly copy the string to new memory
    pub fn set_product_str(&self, val: &str) -> Result<()> {
        try_unsafe!(libusbd_set_product_str(self.context, CString::new(val).unwrap().as_ptr()));

        Ok(())
    }

    /// Sets the port's serial number string
    #[allow(temporary_cstring_as_ptr)] // we explicitly copy the string to new memory
    pub fn set_serial_str(&self, val: &str) -> Result<()> {
        try_unsafe!(libusbd_set_serial_str(self.context, CString::new(val).unwrap().as_ptr()));

        Ok(())
    }

    /// Applies the VID, PID, version, class, subclass, protocol, manufacturer string, 
    /// product string, serial number string, and the number of interfaces allocated.
    ///
    /// Interfaces must be allocated before `config_finalize`, and finalized after `config_finalize`
    /// using `iface_finalize`.
    pub fn config_finalize(&self) -> Result<()> {
        try_unsafe!(libusbd_config_finalize(self.context));

        Ok(())
    }

    /// Allocates an interface for a kernel/builtin driver.
    #[allow(temporary_cstring_as_ptr)] // we explicitly copy the string to new memory
    pub fn iface_alloc_builtin(&self, name: &str) -> Result<()> {
        try_unsafe!(libusbd_iface_alloc_builtin(self.context, CString::new(name).unwrap().as_ptr()));

        Ok(())
    }

    /// Allocates an interface index for the port's configuration.
    pub fn iface_alloc(&self) -> Result<u8> {
        let mut out: u8 = 0xFF;

        try_unsafe!(libusbd_iface_alloc(self.context, &mut out));

        Ok(out)
    }

    /// Finalizes the interface's standard descriptors, nonstandard descriptors, endpoints,
    /// class, subclass, and protocol.
    ///
    /// This function can only be called after the configuration is finalized using `config_finalize`.
    pub fn iface_finalize(&self, iface_num: u8) -> Result<()> {
        try_unsafe!(libusbd_iface_finalize(self.context, iface_num));

        Ok(())
    }

    /// Adds a standard descriptor to the interface.
    /// These descriptors can be retrieved from both the interface descriptor,
    /// as well as explicitly using setup packets.
    ///
    /// An example of this would be a HID descriptor, which includes the index for the non-standard
    /// setup descriptor which is retrieved using a setup packet.
    pub fn iface_standard_desc(&self, iface_num: u8, desc_type: u8, unk: u8, pDesc: &[u8]) -> Result<()> {
        try_unsafe!(libusbd_iface_standard_desc(self.context, iface_num, desc_type, unk, pDesc.as_ptr(), pDesc.len() as u64));

        Ok(())
    }

    /// Adds a non-standard descriptor to the interface.
    /// These descriptors can only be retrieved explicitly using setup packets,
    /// and will not be included in the interface descriptor.
    ///
    /// An example of this would be a HID report descriptor, which has its index specified by the
    /// standard descriptor.
    pub fn iface_nonstandard_desc(&self, iface_num: u8, desc_type: u8, unk: u8, pDesc: &[u8]) -> Result<()> {
        try_unsafe!(libusbd_iface_nonstandard_desc(self.context, iface_num, desc_type, unk, pDesc.as_ptr(), pDesc.len() as u64));

        Ok(())
    }

    /// Adds an endpoint to the specified interface.
    pub fn iface_add_endpoint(&self, iface_num: u8, ep_type: u8, direction: u8, max_pkt_size: u32, interval: u8, unk: u64) -> Result<u64> {
        let mut out: u64 = 0xFFFFFFFFFFFFFFFF;

        try_unsafe!(libusbd_iface_add_endpoint(self.context, iface_num, ep_type, direction, max_pkt_size, interval, unk, &mut out));

        Ok(out)
    }

    /// Sets the interface class ID.
    pub fn iface_set_class(&self, iface_num: u8, val: u8) -> Result<()> {
        try_unsafe!(libusbd_iface_set_class(self.context, iface_num, val));

        Ok(())
    }

    /// Sets the interface subclass ID.
    pub fn iface_set_subclass(&self, iface_num: u8, val: u8) -> Result<()> {
        try_unsafe!(libusbd_iface_set_subclass(self.context, iface_num, val));

        Ok(())
    }

    /// Sets the interface protocol ID.
    pub fn iface_set_protocol(&self, iface_num: u8, val: u8) -> Result<()> {
        try_unsafe!(libusbd_iface_set_protocol(self.context, iface_num, val));

        Ok(())
    }

    /// Reads from an endpoint.
    pub fn ep_read(&self, iface_num: u8, ep: u64, data_out: &mut [u8], timeout_ms: u64) -> Result<i32> {
        let read = try_unsafe!(libusbd_ep_read(self.context, iface_num, ep, data_out.as_mut_ptr() as *mut c_void, data_out.len() as u32, timeout_ms));

        Ok(read)
    }

    /// Writes to an endpoint.
    pub fn ep_write(&self, iface_num: u8, ep: u64, data_in: &[u8], timeout_ms: u64) -> Result<i32> {
        let written = try_unsafe!(libusbd_ep_write(self.context, iface_num, ep, data_in.as_ptr() as *const c_void, data_in.len() as u32, timeout_ms));

        Ok(written)
    }

    ///Stalls an endpoint.
    pub fn ep_stall(&self, iface_num: u8, ep: u64) -> Result<()> {
        try_unsafe!(libusbd_ep_stall(self.context, iface_num, ep));

        Ok(())
    }

    /// Aborts an endpoint.
    pub fn ep_abort(&self, iface_num: u8, ep: u64) -> Result<()> {
        try_unsafe!(libusbd_ep_abort(self.context, iface_num, ep));

        Ok(())
    }

    /// Returns true if an endpoint as completed an asynchronous transfer.
    pub fn ep_transfer_done(&self, iface_num: u8, ep: u64) -> Result<bool> {
        let ret = try_unsafe!(libusbd_ep_transfer_done(self.context, iface_num, ep));

        Ok(ret != 0)
    }

    /// Returns the number of transferred bytes from the last async transaction.
    pub fn ep_transferred_bytes(&self, iface_num: u8, ep: u64) -> Result<i32> {
        let ret = try_unsafe!(libusbd_ep_transferred_bytes(self.context, iface_num, ep));

        Ok(ret)
    }

    /// Returns a pointer to the underlying endpoint transfer buffer. 
    /// This buffer may be modified at any time following an endpoint read/write,
    /// and contents should be copied before scheduling another transaction.
    pub fn ep_get_buffer(&self, iface_num: u8, ep: u64) -> Result<&mut [u8]> {
        let mut buffer_ptr = core::mem::MaybeUninit::<*mut c_void>::uninit();
        let buffer_size: i32;
        let buffer_ptr_state = unsafe {
            match libusbd_ep_get_buffer(self.context, iface_num, ep, buffer_ptr.as_mut_ptr()) as i32 {
                err if err < 0 => return Err(error::from_libusbd(err)),
                val => buffer_size = val,
            };
            buffer_ptr.assume_init()
        };

        let buf = unsafe { slice::from_raw_parts_mut(buffer_ptr_state as *mut u8, buffer_size as usize) };

        Ok(buf)
    }

    /// Schedules a write transaction on an endpoint.
    /// Data is copied to the underlying buffer before returning a Future.
    ///
    /// EpFutures return the number of bytes transferred if successful, or the error otherwise.
    pub fn ep_write_async<'a>(&'a self, iface_num: u8, ep: u64, data_in: &[u8], timeout_ms: u64) -> Result<EpFuture<'a>> {
        try_unsafe!(libusbd_ep_write_start(self.context, iface_num, ep, data_in.as_ptr() as *const c_void, data_in.len() as u32, timeout_ms));

        Ok(EpFuture { context: self, iface_num: iface_num, ep: ep, timeout_ms: timeout_ms, time_waited: 0 })
    }

    /// Schedules a read transaction on an endpoint.
    /// Data is accessible through `ep_get_buffer` after the returned Future is complete.
    ///
    /// EpFutures return the number of bytes transferred if successful, or the error otherwise.
    pub fn ep_read_async<'a>(&'a self, iface_num: u8, ep: u64, len: u32, timeout_ms: u64) -> Result<EpFuture<'a>> {
        try_unsafe!(libusbd_ep_read_start(self.context, iface_num, ep, len, timeout_ms));

        Ok(EpFuture { context: self, iface_num: iface_num, ep: ep, timeout_ms: timeout_ms, time_waited: 0 })
    }

}