# CPU to GPU Probe

This experimental MintBrew app displays the console's qualified CPU timer
counter and frequency after the host copies them into an app-owned 4 KiB GPU
storage buffer. The large number is the low 32 bits of the counter; the lower
rows show the 31,250,000 Hz frequency and GPU frame count. The bar fills once
per CPU second. Mint indicates a valid frequency and red indicates the
mailbox is missing or uninitialized.

Press B or Minus to return to MintBrew. No custom CPU code is executed.
The display still needs a console test.

Build the shader package with:

```sh
node build.cjs
```
