use libusbd::{Context, EpType, EpDir};
use std::time;
use futures::executor::block_on;
use async_std::task;
use std::io::{self, Write};
use std::thread;

use std::sync::mpsc::{Sender, Receiver};
use std::sync::mpsc;

mod support;
use glutin::event::{Event, WindowEvent, DeviceEvent, ElementState, VirtualKeyCode, MouseButton, MouseScrollDelta};
use glutin::event_loop::{ControlFlow, EventLoop};
use glutin::window::WindowBuilder;
use glutin::ContextBuilder;

use std::time::Instant;

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
        task::sleep(time::Duration::from_millis(1)).await;
    }
}

struct SentKeypress
{
    scancode: u32,
    pressed: bool,
}

struct SentMouse
{
    button: u8,
    pressed: bool,
    dx: i16,
    dy: i16,
    wheel_dx: i8,
    wheel_dy: i8,
}

async fn nop_async() {}

async fn usb_print_task(rx: Receiver<SentKeypress>, rx_mouse: Receiver<SentMouse>)
{
    let context = libusbd::Context::new().unwrap();

    must_succeed!(context.set_vid(0x1234));
    must_succeed!(context.set_pid(0x1234));

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

    let iface_num_mouse = match context.iface_alloc() {
        Ok(n) => n,
        Err(error) => panic!("Couldn't allocate interface: {:?}", error),
    };

    match context.iface_alloc_builtin("libusbd_std_ncm") {
        Ok(_) => (),
        Err(error) => panic!("Couldn't allocate std interface: {:?}", error),
    };

    must_succeed!(context.config_finalize());

    must_succeed!(context.iface_set_class(iface_num, 3));
    must_succeed!(context.iface_set_subclass(iface_num, 1));
    must_succeed!(context.iface_set_protocol(iface_num, 1));

    must_succeed!(context.iface_set_class(iface_num_mouse, 3));
    must_succeed!(context.iface_set_subclass(iface_num_mouse, 1));
    must_succeed!(context.iface_set_protocol(iface_num_mouse, 2));

    let hid_desc: [u8; 9] = [0x09, 0x21, 0x11, 0x01, 0x00, 0x01, 0x22, 65, 0x00];
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
    let ep_out = match context.iface_add_endpoint(iface_num, EpType::INTR, EpDir::IN, 8, 8, 0) {
        Ok(n) => n,
        Err(error) => panic!("Couldn't add endpoint: {:?}", error),
    };
    must_succeed!(context.iface_finalize(iface_num));

    let hid_desc_mouse: [u8; 9] = [0x09, 0x21, 0x11, 0x01, 0x00, 0x01, 0x22, 215, 0x00];
    let hid_report_desc_mouse: [u8; 215] = [
        0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x09, 0x01, 0xa1, 0x00, 0x85, 0x01, 0x05, 0x09, 0x19, 0x01,
        0x29, 0x05, 0x15, 0x00, 0x25, 0x01, 0x95, 0x05, 0x75, 0x01, 0x81, 0x02, 0x95, 0x01, 0x75, 0x03,
        0x81, 0x01, 0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x16, 0x00, 0x80, 0x26, 0xff, 0x7f, 0x75, 0x10,
        0x95, 0x02, 0x81, 0x06, 0xc0, 0xa1, 0x00, 0x05, 0x01, 0x09, 0x38, 0x15, 0x81, 0x25, 0x7f, 0x75,
        0x08, 0x95, 0x01, 0x81, 0x06, 0xc0, 0xa1, 0x00, 0x05, 0x0c, 0x0a, 0x38, 0x02, 0x95, 0x01, 0x75,
        0x08, 0x15, 0x81, 0x25, 0x7f, 0x81, 0x06, 0xc0, 0xc0, 0x06, 0x01, 0xff, 0x09, 0x00, 0xa1, 0x01,
        0x85, 0x02, 0x09, 0x00, 0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08, 0x95, 0x07, 0x81, 0x02, 0xc0,
        0x05, 0x0c, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x05, 0x15, 0x00, 0x26, 0x3c, 0x02, 0x19, 0x00, 0x2a,
        0x3c, 0x02, 0x75, 0x10, 0x95, 0x01, 0x81, 0x00, 0xc0, 0x05, 0x01, 0x09, 0x80, 0xa1, 0x01, 0x85,
        0x03, 0x19, 0x81, 0x29, 0x83, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02, 0x95,
        0x01, 0x75, 0x05, 0x81, 0x01, 0xc0, 0x06, 0xbc, 0xff, 0x09, 0x88, 0xa1, 0x01, 0x85, 0x04, 0x95,
        0x01, 0x75, 0x08, 0x15, 0x00, 0x26, 0xff, 0x00, 0x19, 0x00, 0x2a, 0xff, 0x00, 0x81, 0x00, 0xc0,
        0x06, 0x02, 0xff, 0x09, 0x02, 0xa1, 0x01, 0x85, 0x06, 0x09, 0x02, 0x15, 0x00, 0x26, 0xff, 0x00,
        0x75, 0x08, 0x95, 0x07, 0xb1, 0x02, 0xc0
    ];

    must_succeed!(context.iface_standard_desc(iface_num_mouse, 0x21, 0xF, &hid_desc_mouse));
    must_succeed!(context.iface_nonstandard_desc(iface_num_mouse, 0x22, 0xF, &hid_report_desc_mouse));
    let ep_out_mouse = match context.iface_add_endpoint(iface_num_mouse, EpType::INTR, EpDir::IN, 8, 8, 0) {
        Ok(n) => n,
        Err(error) => panic!("Couldn't add endpoint: {:?}", error),
    };
    must_succeed!(context.iface_finalize(iface_num_mouse));

    let mut keyboard_send: [u8; 8] = [0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0];
    let mut mouse_send: [u8; 0x8] = [0x1, 0x0,  0x0, 0x0,  0x0, 0x0,   0x0, 0x0];
    let mut mouse_btns: u8 = 0;

    println!("begin loop");

    let mut last_loop = Instant::now();

    loop {
        let mut needs_update = false;
        let mut mouse_needs_update = false;

        for _i in 0..6 {
            let event = match rx.try_recv() {
                Ok(event) => event,
                _ => { break; },
            };

            let trunc_scancode: u8 = (event.scancode & 0xFF) as u8;

            if event.pressed {
                let mut already_pressed = false;
                for j in 0..6 {
                    if keyboard_send[2+j] == trunc_scancode {
                        already_pressed = true;
                    }
                }

                if !already_pressed {
                    for j in 0..6 {
                        if keyboard_send[2+j] == 0 {
                            keyboard_send[2+j] = trunc_scancode;
                            needs_update = true;
                            break;
                        }
                    }
                }
            }
            else {
                for j in 0..6 {
                    if keyboard_send[2+j] == trunc_scancode {
                        keyboard_send[2+j] = 0;
                        needs_update = true;
                    }
                }
            }

            //println!("{} {}", event.scancode, event.pressed);
        }

        let mut dx = 0;
        let mut dy = 0;
        let mut wheel_dx: i16 = 0;
        let mut wheel_dy: i16 = 0;

        for _i in 0..100 {
            let event = match rx_mouse.try_recv() {
                Ok(event) => event,
                _ => { break; },
            };

            let btn: u8 = event.button;

            if event.pressed {
                mouse_btns |= btn;
            }
            else {
                mouse_btns &= !btn;
            }

            dx += event.dx;
            dy += event.dy;

            wheel_dx += event.wheel_dx as i16;
            wheel_dy += event.wheel_dy as i16;

            wheel_dx = wheel_dx.max(-127).min(127);
            wheel_dy = wheel_dy.max(-127).min(127);

            mouse_needs_update = true;

            //println!("{} {}", event.scancode, event.pressed);
        }

        mouse_send[1] = mouse_btns;
        mouse_send[2] = (dx as u16 & 0xFF) as u8;
        mouse_send[3] = ((dx as u16 & 0xFF00) >> 8) as u8;
        mouse_send[4] = (dy as u16 & 0xFF) as u8;
        mouse_send[5] = ((dy as u16 & 0xFF00) >> 8) as u8;
        mouse_send[6] = wheel_dy as u8;
        mouse_send[7] = wheel_dx as u8;
        if wheel_dy != 0 {
        println!("{}", wheel_dy);
    }

        if needs_update || mouse_needs_update {
            //println!("{:?} {:?}", keyboard_send, mouse_send);
        }

        /*let elapsed = last_loop.elapsed();
        last_loop = Instant::now();
        if elapsed.as_millis() != 0 {
            println!("{:?}", elapsed.as_millis());
        }*/

        let mut send_future_1 = None;
        if needs_update {
            send_future_1 = match context.ep_write_async(iface_num, ep_out, &keyboard_send, 100)
            {
                Ok(f) => Some(f),
                Err(err) => {
                    println!("Got error 1: {:?}", err);
                    //task::sleep(time::Duration::from_millis(1000)).await;
                    //continue;
                    None
                },
            };
        }

        let mut send_future_2 = None;
        if mouse_needs_update {
            send_future_2 = match context.ep_write_async(iface_num_mouse, ep_out_mouse, &mouse_send, 100)
            {
                Ok(f) => Some(f),
                Err(err) => {
                    println!("Got error 2: {:?}", err);
                    //task::sleep(time::Duration::from_millis(1000)).await;
                    //continue;
                    None
                },
            };
        }

        // This also reports the number of bytes written, if Ok
        if let Some(f) = send_future_1 {
            match f.await {
                Err(err) => {
                    println!("Got error await 1: {:?}", err);
                    //task::sleep(time::Duration::from_millis(1000)).await;
                    //continue;
                },
                Ok(_) => (),
            };
        }

        // This also reports the number of bytes written, if Ok
        if let Some(f) = send_future_2 {
            match f.await {
                Err(err) => {
                    println!("Got error await 2: {:?}", err);
                    //task::sleep(time::Duration::from_millis(1000)).await;
                    //continue;
                },
                Ok(_) => (),
            };
        }

        task::yield_now().await;
        
        //task::sleep(time::Duration::from_millis(1)).await;
    }
}

fn real_scancode(keycode: VirtualKeyCode) -> u32 {
    match keycode {
        VirtualKeyCode::Key1 => 0x1e,
        VirtualKeyCode::Key2 => 0x1f,
        VirtualKeyCode::Key3 => 0x20,
        VirtualKeyCode::Key4 => 0x21,
        VirtualKeyCode::Key5 => 0x22,
        VirtualKeyCode::Key6 => 0x23,
        VirtualKeyCode::Key7 => 0x24,
        VirtualKeyCode::Key8 => 0x25,
        VirtualKeyCode::Key9 => 0x26,
        VirtualKeyCode::Key0 => 0x27,

        VirtualKeyCode::A => 0x4,
        VirtualKeyCode::B => 0x5,
        VirtualKeyCode::C => 0x6,
        VirtualKeyCode::D => 0x7,
        VirtualKeyCode::E => 0x8,
        VirtualKeyCode::F => 0x9,
        VirtualKeyCode::G => 0xa,
        VirtualKeyCode::H => 0xb,
        VirtualKeyCode::I => 0xc,
        VirtualKeyCode::J => 0xd,
        VirtualKeyCode::K => 0xe,
        VirtualKeyCode::L => 0xf,
        VirtualKeyCode::M => 0x10,
        VirtualKeyCode::N => 0x11,
        VirtualKeyCode::O => 0x12,
        VirtualKeyCode::P => 0x13,
        VirtualKeyCode::Q => 0x14,
        VirtualKeyCode::R => 0x15,
        VirtualKeyCode::S => 0x16,
        VirtualKeyCode::T => 0x17,
        VirtualKeyCode::U => 0x18,
        VirtualKeyCode::V => 0x19,
        VirtualKeyCode::W => 0x1a,
        VirtualKeyCode::X => 0x1b,
        VirtualKeyCode::Y => 0x1c,
        VirtualKeyCode::Z => 0x1d,

        VirtualKeyCode::Escape => 0x29,

        VirtualKeyCode::F1 => 0x3a,
        VirtualKeyCode::F2 => 0x3b,
        VirtualKeyCode::F3 => 0x3c,
        VirtualKeyCode::F4 => 0x3d,
        VirtualKeyCode::F5 => 0x3e,
        VirtualKeyCode::F6 => 0x3f,
        VirtualKeyCode::F7 => 0x40,
        VirtualKeyCode::F8 => 0x41,
        VirtualKeyCode::F9 => 0x42,
        VirtualKeyCode::F10 => 0x43,
        VirtualKeyCode::F11 => 0x44,
        VirtualKeyCode::F12 => 0x45,
        VirtualKeyCode::F13 => 0x68,
        VirtualKeyCode::F14 => 0x69,
        VirtualKeyCode::F15 => 0x6a,
        VirtualKeyCode::F16 => 0x6b,
        VirtualKeyCode::F17 => 0x6c,
        VirtualKeyCode::F18 => 0x6d,
        VirtualKeyCode::F19 => 0x6e,
        VirtualKeyCode::F20 => 0x6f,
        VirtualKeyCode::F21 => 0x70,
        VirtualKeyCode::F22 => 0x71,
        VirtualKeyCode::F23 => 0x72,
        VirtualKeyCode::F24 => 0x73,

        VirtualKeyCode::Snapshot => 0x46,
        VirtualKeyCode::Scroll => 0x47,
        VirtualKeyCode::Pause => 0x48,
        VirtualKeyCode::Insert => 0x49,
        VirtualKeyCode::Home => 0x4a,
        VirtualKeyCode::Delete => 0x4c,
        VirtualKeyCode::End => 0x4d,
        VirtualKeyCode::PageDown => 0x4e,
        VirtualKeyCode::PageUp => 0x4b,
        VirtualKeyCode::Left => 0x50,
        VirtualKeyCode::Up => 0x52,
        VirtualKeyCode::Right => 0x4f,
        VirtualKeyCode::Down => 0x51,
        VirtualKeyCode::Back => 0x2a,
        VirtualKeyCode::Return => 0x28,
        VirtualKeyCode::Space => 0x2c,
        VirtualKeyCode::Numlock => 0x53,
        VirtualKeyCode::Numpad0 => 0x62,
        VirtualKeyCode::Numpad1 => 0x59,
        VirtualKeyCode::Numpad2 => 0x5a,
        VirtualKeyCode::Numpad3 => 0x5b,
        VirtualKeyCode::Numpad4 => 0x5c,
        VirtualKeyCode::Numpad5 => 0x5d,
        VirtualKeyCode::Numpad6 => 0x5e,
        VirtualKeyCode::Numpad7 => 0x5f,
        VirtualKeyCode::Numpad8 => 0x60,
        VirtualKeyCode::Numpad9 => 0x61,
        VirtualKeyCode::NumpadAdd => 0x57,
        VirtualKeyCode::NumpadDivide => 0x54,
        VirtualKeyCode::NumpadComma => 0x85,
        VirtualKeyCode::NumpadDecimal => 0x63,
        VirtualKeyCode::NumpadEnter => 0x58,
        VirtualKeyCode::NumpadEquals => 0x67,
        VirtualKeyCode::NumpadMultiply => 0x55,
        VirtualKeyCode::NumpadSubtract => 0x56,

        VirtualKeyCode::Apostrophe => 0x34,
        VirtualKeyCode::Apps => 0x65,
        VirtualKeyCode::Asterisk => 0x55,
        // At, Ax
        VirtualKeyCode::Backslash => 0x31,
        VirtualKeyCode::Calculator => 0xfb,
        VirtualKeyCode::Capital => 0x39,
        VirtualKeyCode::Colon => 0x33, // ??
        VirtualKeyCode::Comma => 0x36,
        // Convert
        VirtualKeyCode::Equals => 0x2e,
        VirtualKeyCode::Grave => 0x35,
        // Kana, Kanji
        VirtualKeyCode::LAlt => 0xe2,
        VirtualKeyCode::LBracket => 0x2f,
        VirtualKeyCode::LControl => 0xe0,
        VirtualKeyCode::LShift => 0xe1,
        VirtualKeyCode::LWin => 0xe3,
        //Mail =>  
        // MediaSelect, MediaStop,
        VirtualKeyCode::Minus => 0x2d,
        // Mute, MyComputer, NavigateForward, NavigateBackward, NextTrack, NoConvert, OEM102,
        VirtualKeyCode::Period => 0x37,
        // PlayPause
        //Plus => 
        VirtualKeyCode::RAlt => 0xe6,
        VirtualKeyCode::RBracket => 0x30,
        VirtualKeyCode::RControl => 0xe4,
        VirtualKeyCode::RShift => 0xe5,
        VirtualKeyCode::RWin => 0xe7,
        VirtualKeyCode::Semicolon => 0x33,
        VirtualKeyCode::Slash => 0x38,
        // Sleep, Stop, Sysrq,
        VirtualKeyCode::Tab => 0x2b,
        // Underline, Unlabeled, VolDown, VolUp, Wake, WebBack..WebStop, Yen, Copy, Paste, Cut

        _ => 0x0,
    }
}

fn convert_mousebuttons(button: MouseButton) -> u8 {
    match button {
        MouseButton::Left => 0x1,
        MouseButton::Right => 0x2,
        MouseButton::Middle => 0x4,
        _ => 0x0,
    }
}

fn window(tx: Sender<SentKeypress>, tx_mouse: Sender<SentMouse>) 
{
    let el = EventLoop::new();
    let wb = WindowBuilder::new().with_title("Capture window");

    let windowed_context = ContextBuilder::new().build_windowed(wb, &el).unwrap();

    let windowed_context = unsafe { windowed_context.make_current().unwrap() };

    println!("Pixel format of the window's GL context: {:?}", windowed_context.get_pixel_format());

    let gl = support::load(&windowed_context.context());

    el.run(move |event, _, control_flow| {
        //println!("{:?}", event);
        *control_flow = ControlFlow::Wait;

        match event {
            Event::LoopDestroyed => return,
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::Resized(physical_size) => windowed_context.resize(physical_size),
                WindowEvent::CloseRequested => *control_flow = ControlFlow::Exit,
                WindowEvent::KeyboardInput { input, .. } => {
                    if let Some(k) = input.virtual_keycode {
                    let code = real_scancode(k);
                    //println!("{:?} {:x}", input, code);
                    tx.send(SentKeypress { scancode: code, pressed: input.state == ElementState::Pressed});
                    }
                },
                WindowEvent::MouseInput { button, state, .. } => {
                    //println!("{:?}", event);
                    tx_mouse.send(SentMouse { button:convert_mousebuttons(button), pressed: state == ElementState::Pressed, dx: 0, dy: 0, wheel_dx: 0, wheel_dy: 0 });
                },
                _ => (),
            },
            Event::RedrawRequested(_) => {
                gl.draw_frame([1.0, 0.5, 0.7, 1.0]);
                windowed_context.swap_buffers().unwrap();
            },
            Event::DeviceEvent { event, .. } => match event {
                DeviceEvent::MouseMotion { delta } => {
                    //println!("{:?}", event);
                    tx_mouse.send(SentMouse { button:0, pressed: false, dx: delta.0 as i16, dy: delta.1 as i16, wheel_dx: 0, wheel_dy: 0 });
                },
                DeviceEvent::MouseWheel { delta } => {
                    //println!("{:?}", event);
                    let mut dx = 0;
                    let mut dy = 0;

                    match delta {
                        MouseScrollDelta::LineDelta(a,b) => {
                            let mut f_dx = a.max(-1.0).min(1.0);
                            let mut f_dy = b.max(-1.0).min(1.0);
                            dx = (f_dx * 127.0) as i8;
                            dy = (f_dy * 127.0) as i8;
                        },
                        _ => (),
                    };
                    tx_mouse.send(SentMouse { button:0, pressed: false, dx: 0, dy: 0, wheel_dx: dx, wheel_dy: dy });
                },
                _ => (),
            },
            _ => (),
        }
    });
}

fn main() {
    let (tx, rx): (Sender<SentKeypress>, Receiver<SentKeypress>) = mpsc::channel();
    let (tx_mouse, rx_mouse): (Sender<SentMouse>, Receiver<SentMouse>) = mpsc::channel();

    let handle = thread::spawn(move || { 
        block_on(async { futures::join!(usb_print_task(rx, rx_mouse), speen_task()) } );
    });
    window(tx, tx_mouse);
    handle.join().unwrap();
    
}
