# inherited indentation test

this is a separate experimental sender; the original `sender.c` is unchanged.
smilebasic carries the previous line’s leading spaces into the next line.
the sender uses backspace or space to reach the next line's desired indent;
it never sends home, shift+home, or backspace to the beginning of a line.

1. extract the zip and `cd mac2jb` (the directory containing `Makefile`).
2. run `make mac2jb-indent-test`.
3. clear the editor completely, place cursor at column 1.
4. run `MAC2JB_CONTROLLER=usb-drd1 ./mac2jb-indent-test indent-test.bas --delay-ms 50`.
5. enter `SEND` after checking the target.
6. verify every line; do not run the test file.

if the indentation looks wrong, stop with ctrl+c. if a key keeps repeating,
unplug and reconnect the cable. do not send the bootstrap until this test works.
