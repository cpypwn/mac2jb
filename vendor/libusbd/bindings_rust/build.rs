extern crate bindgen;

use std::env;
use std::env::consts;
use std::path::Path;
use std::path::PathBuf;

fn main() {

    // These are absolute paths, to avoid any relative path issues
    if let Ok(include_dir) = env::var("LIBUSBD_INCLUDE_DIR") {
        println!("cargo:include={}", include_dir);
    }
    else {
        println!("cargo:include=../include");
    }

    if let Some(lib_dir) = env::var_os("LIBUSBD_LIB_DIR") {
        let lib_dir = Path::new(&lib_dir);
        let dylib_name = format!("{}usbd{}", consts::DLL_PREFIX, consts::DLL_SUFFIX);
        if lib_dir.join(dylib_name).exists() ||
           lib_dir.join("libusbd.a").exists() ||
           lib_dir.join("usbd.lib").exists() {
            println!("cargo:rustc-link-search=native={}", lib_dir.display());
            println!("cargo:rustc-link-lib=usbd");
        }
    }
    else {
        println!("cargo:rustc-link-search=..");
        println!("cargo:rustc-link-lib=usbd");
    }

    
    let include_path = match env::var("LIBUSBD_INCLUDE_DIR") {
        Ok(s) => PathBuf::from(s),
        _ => PathBuf::from("../include")
    };

    // Build our args and generate
    println!("cargo:rerun-if-changed=wrapper.h");
    let bindings = bindgen::Builder::default()
        .header("wrapper.h")
        .clang_arg("-isystem")
        .clang_arg(include_path.to_str().unwrap())
        //.clang_arg(lib_arg)
        .generate()
        .expect("Unable to generate bindings");

    // Write the bindings to the $OUT_DIR/bindings.rs file.
    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out_path.join("bindings.rs"))
        .expect("Couldn't write bindings!");
}