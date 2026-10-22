use libusbd::{Context, EpType, EpDir};
use std::time;
use futures::executor::block_on;
use async_std::task;
use std::io::{self, Write};

macro_rules! must_succeed {
    ($x:expr) => {
        match $x {
            Ok(n) => n,
            Err(err) => panic!("Got error: {:?}", err),
        }
    }
}

async fn speen_task() {
    let mut idx: usize = 0;

    loop {
        let speen = vec!['/', '-', '\\', '|'];
        print!("Speen {}\r", speen[idx % 4]);
        idx += 1;

        if idx > 60 {
            idx = 0;
        }

        io::stdout().flush().unwrap();
        task::sleep(time::Duration::from_millis(16)).await;
    }
}

async fn usb_print_task(context: Context, iface_num: u8, ep_out: u64)
{
    let test_send: [u8; 8] = [0x0, 0x0, 0x20, 0x0, 0x0, 0x0, 0x0, 0x0];
    let test_send_2: [u8; 8] = [0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0];

    loop {
        let send_future_1 = match context.ep_write_async(iface_num, ep_out, &test_send, 1000)
        {
            Ok(f) => f,
            Err(err) => {
                println!("Got error: {:?}", err);
                task::sleep(time::Duration::from_millis(1000)).await;
                continue;
            },
        };

        // This also reports the number of bytes written, if Ok
        match send_future_1.await {
            Err(err) => {
                println!("Got error: {:?}", err);
                task::sleep(time::Duration::from_millis(1000)).await;
                continue;
            },
            Ok(_) => (),
        };
        task::sleep(time::Duration::from_millis(16)).await;

        let send_future_2 = match context.ep_write_async(iface_num, ep_out, &test_send_2, 1000)
        {
            Ok(f) => f,
            Err(err) => {
                println!("Got error: {:?}", err);
                task::sleep(time::Duration::from_millis(1000)).await;
                continue;
            },
        };

        // This also reports the number of bytes written, if Ok
        match send_future_2.await {
            Err(err) => {
                println!("Got error: {:?}", err);
                task::sleep(time::Duration::from_millis(1000)).await;
                continue;
            },
            Ok(_) => (),
        };
        task::sleep(time::Duration::from_millis(16)).await;
    }
}

fn main() {
    let context = libusbd::Context::new().unwrap();

    must_succeed!(context.set_vid(0x1234));
    must_succeed!(context.set_pid(0x1235));

    must_succeed!(context.set_class(0));
    must_succeed!(context.set_subclass(0));
    must_succeed!(context.set_protocol(0));

    must_succeed!(context.set_manufacturer_str("Manufacturer"));
    must_succeed!(context.set_product_str("Product"));
    must_succeed!(context.set_serial_str("Serial"));

    let iface_num = match context.iface_alloc() {
        Ok(n) => n,
        Err(error) => panic!("Couldn't allocate interface: {:?}", error),
    };

    must_succeed!(context.config_finalize());

    must_succeed!(context.iface_set_class(iface_num, 3));
    must_succeed!(context.iface_set_subclass(iface_num, 1));
    must_succeed!(context.iface_set_protocol(iface_num, 1));

    let hid_desc: [u8; 9] = [0x09, 0x21, 0x11, 0x01, 0x00, 0x01, 0x22, 0x41, 0x00];
    let hid_report_desc: [u8; 65] = [
        0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x05, 0x07, 
        0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
        0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x95, 0x01, 
        0x75, 0x08, 0x81, 0x01, 0x95, 0x03, 0x75, 0x01,
        0x05, 0x08, 0x19, 0x01, 0x29, 0x03, 0x91, 0x02, 
        0x95, 0x05, 0x75, 0x01, 0x91, 0x01, 0x95, 0x06,
        0x75, 0x08, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x05, 
        0x07, 0x19, 0x00, 0x2A, 0xFF, 0x00, 0x81, 0x00,
        0xC0
    ];

    must_succeed!(context.iface_standard_desc(iface_num, 0x21, 0xF, &hid_desc));
    must_succeed!(context.iface_nonstandard_desc(iface_num, 0x22, 0xF, &hid_report_desc));
    let ep_out = match context.iface_add_endpoint(iface_num, EpType::INTR, EpDir::IN, 8, 10, 0) {
        Ok(n) => n,
        Err(error) => panic!("Couldn't add endpoint: {:?}", error),
    };
    must_succeed!(context.iface_finalize(iface_num));

    block_on(async { futures::join!(usb_print_task(context, iface_num, ep_out), speen_task()) } );
}
