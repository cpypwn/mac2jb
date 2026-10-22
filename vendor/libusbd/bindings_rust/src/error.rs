use std::fmt;
use std::error::Error as StdError;
use std::result::Result as StdResult;

use crate as libusbd;

/// A result of a function that may return a `Error`.
pub type Result<T> = StdResult<T, Error>;


/// Errors returned by the `libusbd` library.
#[derive(Debug)]
pub enum Error {
    /// Success (no error).
    Success,

    /// Invalid argument passed
    InvalidArgument,

    /// USB device is not enumerated yet
    NotEnumerated,

    /// Access denied (insufficient permissions).
    Timeout,

    /// Not implemented
    NotImplemented,

    /// Resource limit reached.
    ResourceLimit,

    /// Resource is already finalized and cannot be modified.
    AlreadyFinalized,

    /// Unknown or undescribed error.
    Nondescript,

    /// Invalid value
    Invalid,
}

impl Error {
    /// Returns a description of an error suitable for display to an end user.
    pub fn strerror(&self) -> &'static str {
        match *self {
            Error::Success          => "Success",
            Error::InvalidArgument  => "Invalid argument passed",
            Error::NotEnumerated    => "USB device is not enumerated yet",
            Error::Timeout          => "Timed out",
            Error::NotImplemented   => "Not implemented",
            Error::ResourceLimit    => "Resource limit reached",
            Error::AlreadyFinalized => "Resource is already finalized and cannot be modified",
            Error::Nondescript      => "Unknown or undescribed error",
            Error::Invalid           => "Invalid"
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, fmt: &mut fmt::Formatter) -> StdResult<(), fmt::Error> {
        fmt.write_str(self.strerror())
    }
}

impl StdError for Error {
    fn description(&self) -> &'static str {
        self.strerror()
    }
}


#[doc(hidden)]
pub fn from_libusbd(err: ::std::os::raw::c_int) -> Error {
    match err {
        libusbd::libusbd_error_LIBUSBD_SUCCESS                 => Error::Success,
        libusbd::libusbd_error_LIBUSBD_INVALID_ARGUMENT        => Error::InvalidArgument,
        libusbd::libusbd_error_LIBUSBD_NOT_ENUMERATED          => Error::NotEnumerated,
        libusbd::libusbd_error_LIBUSBD_TIMEOUT                 => Error::Timeout,
        libusbd::libusbd_error_LIBUSBD_NOT_IMPLEMENTED         => Error::NotImplemented,
        libusbd::libusbd_error_LIBUSBD_RESOURCE_LIMIT_REACHED  => Error::ResourceLimit,
        libusbd::libusbd_error_LIBUSBD_ALREADY_FINALIZED       => Error::AlreadyFinalized,
        libusbd::libusbd_error_LIBUSBD_NONDESCRIPT_ERROR       => Error::Nondescript,
        _ => Error::Invalid,
    }
}

#[doc(hidden)]
macro_rules! try_unsafe {
    ($x:expr) => {
        match unsafe { $x as i32 } {
            err if err < 0 => return Err($crate::error::from_libusbd(err)),
            val => val,
        }
    }
}