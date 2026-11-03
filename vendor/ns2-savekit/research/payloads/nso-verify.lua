-- NSO0 header verification for the in-game Lua sandbox.
--
-- The console-side counterpart of tools/nso-verify.cjs. It checks what
-- can be checked without decompressing: the header says what it is,
-- section ranges are ordered, inside the file and not truncated, the
-- module name is where the format says, and (for an uncompressed
-- section) the text does not start with a zero word. The header hashes
-- cover decompressed data, and this sandbox has no LZ4, so a compressed
-- NSO is only structurally accepted and its contents stay unverified -
-- callers must say so.
--
-- Lua 5.1, kept to 80 columns for console authoring.
local M = {}

local function u16(s, o)
  local a, b = s:byte(o + 1, o + 2)
  if not a or not b then return nil end
  return a + b * 256
end

local function u32(s, o)
  local a, b, c, d = s:byte(o + 1, o + 4)
  if not a or not b or not c or not d then return nil end
  return a + b * 256 + c * 65536 + d * 16777216
end

local function align4k(n)
  return math.floor((n + 4095) / 4096) * 4096
end

local function printable(s)
  if #s == 0 then return false end
  for i = 1, #s do
    local c = s:byte(i)
    if c < 0x20 or c > 0x7e then return false end
  end
  return true
end

-- Returns ok, reason, info
function M.verify(data)
  local info = {}
  local n = #data
  info.bytes = n
  if n < 0x100 then
    return false, 'shorter than the 0x100 header', info
  end
  if data:sub(1, 4) ~= 'NSO0' then
    return false, 'magic is not NSO0', info
  end
  local version = u32(data, 4)
  local reserved = u32(data, 8)
  local flags = u32(data, 0xc)
  info.flags = flags
  if version ~= 0 then
    return false, 'version is ' .. version, info
  end
  if reserved ~= 0 then
    return false, 'reserved word not zero', info
  end
  if flags >= 256 then
    return false, 'unknown flag bits', info
  end
  if flags >= 128 then
    -- bit 7: zbic, a zstd-based compression we cannot check here
    return false, 'zbic NSO unsupported', info
  end

  local names = { 'text', 'rodata', 'data' }
  local offs = { 0x10, 0x20, 0x30 }
  local sizeField = { 0x60, 0x64, 0x68 }
  local seg = {}
  for i = 1, 3 do
    local o = offs[i]
    local fileOff = u32(data, o)
    local memOff = u32(data, o + 4)
    local size = u32(data, o + 8)
    local fileSize = u32(data, sizeField[i])
    if not fileOff or not memOff or not size or not fileSize then
      return false, names[i] .. ': header truncated', info
    end
    if fileOff < 0x100 then
      return false, names[i] .. ': offset in header', info
    end
    if memOff % 4096 ~= 0 then
      return false, names[i] .. ': memory unaligned', info
    end
    if size == 0 or fileSize == 0 then
      return false, names[i] .. ': empty section', info
    end
    local compressedFlag = math.floor(flags / (2 ^ (i - 1))) % 2 == 1
    if not compressedFlag and fileSize ~= size then
      return false, names[i] .. ': size mismatch', info
    end
    if compressedFlag and fileSize > size + 4096 then
      return false, names[i] .. ': sizes disagree', info
    end
    if fileOff + fileSize > n then
      return false, names[i] .. ': truncated at ' ..
        string.format('0x%x', fileOff + fileSize), info
    end
    seg[i] = {name = names[i], fileOff = fileOff, memOff = memOff,
      size = size, fileSize = fileSize, compressed = compressedFlag}
  end
  for i = 2, 3 do
    local prev, cur = seg[i - 1], seg[i]
    if cur.fileOff < prev.fileOff + prev.fileSize then
      return false, cur.name .. ': overlaps ' .. prev.name, info
    end
    if cur.memOff < align4k(prev.memOff + prev.size) then
      return false, cur.name .. ': memory collision', info
    end
  end
  info.text = seg[1]
  info.rodata = seg[2]
  info.data = seg[3]
  info.bss = u32(data, 0x3c)

  local nameOff = u32(data, 0x1c)
  local nameSize = u32(data, 0x2c)
  if nameOff ~= 0x100 then
    return false, 'module name offset', info
  end
  if nameSize < 1 or nameSize > 256 then
    return false, 'module name size', info
  end
  if nameOff + nameSize > n then
    return false, 'module name truncated', info
  end
  local raw = data:sub(nameOff + 1, nameOff + nameSize)
  local name = raw:match('^([^%z]*)')
  if not name or not printable(name) then
    return false, 'module name not printable', info
  end
  info.module = name

  -- An uncompressed text section can be inspected directly.
  if not seg[1].compressed then
    local first = u32(data, seg[1].fileOff)
    if first == 0 then
      return false, 'text starts with zero word', info
    end
  end

  -- Contents were never hashed here (no LZ4 in this sandbox): structural
  -- acceptance is not content proof.
  info.contentsVerified = false
  return true, nil, info
end

return M
