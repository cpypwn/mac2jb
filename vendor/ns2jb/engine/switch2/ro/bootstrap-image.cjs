// Construct the fixed-size NRO container used for the native startup bootstrap.
function makeBootstrapImage(text) {
  if (!Buffer.isBuffer(text)) throw TypeError('Bootstrap text must be a Buffer');
  if (text.length > 0xff80) throw Error('Native bootstrap exceeds text segment');
  const image = Buffer.alloc(0x12000);
  image.write('NRO0', 0x10);
  image.writeUInt32LE(image.length, 0x18);
  image.writeUInt32LE(0x10000, 0x24);
  image.writeUInt32LE(0x10000, 0x28);
  image.writeUInt32LE(0x1000, 0x2c);
  image.writeUInt32LE(0x11000, 0x30);
  image.writeUInt32LE(0x1000, 0x34);
  image.writeUInt32LE(0x1000, 0x38);
  text.copy(image, 0x80);
  return image;
}

module.exports = {makeBootstrapImage};
