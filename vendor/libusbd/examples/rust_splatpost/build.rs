use gl_generator::{Api, Fallbacks, Profile, Registry};
use std::env;
use std::fs::File;
use std::path::PathBuf;
use std::env::consts;
use std::path::Path;

fn main() {
    let dest = PathBuf::from(&env::var("OUT_DIR").unwrap());

    println!("cargo:rerun-if-changed=build.rs");

    let mut file = File::create(&dest.join("gl_bindings.rs")).unwrap();
    Registry::new(Api::Gles2, (3, 3), Profile::Core, Fallbacks::All, [])
        .write_bindings(gl_generator::StructGenerator, &mut file)
        .unwrap();

    if let Some(lib_dir) = env::var_os("LIBUSBD_LIB_DIR") {
        let lib_dir = Path::new(&lib_dir);
        let dylib_name = format!("{}usbd{}", consts::DLL_PREFIX, consts::DLL_SUFFIX);
        if lib_dir.join(dylib_name).exists() ||
           lib_dir.join("libusbd.a").exists() ||
           lib_dir.join("usbd.lib").exists() {
            println!("cargo:rustc-link-search=native={}", lib_dir.display());
        }
    }
    println!("cargo:rustc-link-search=.");
}
