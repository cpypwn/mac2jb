'use strict';
const ABI={open:{offset:0x1045b0,stack:0x70,words:[0xd503237f,0xd101c3ff,0xa9037bfd,0xf90023f7]},directory:{offset:0x1048c0,stack:0x70,words:[0xd503237f,0xd101c3ff,0xa9037bfd,0xf90023f7]},type:{offset:0x1042e0,stack:0x60,words:[0xd503237f,0xd10183ff,0xa9037bfd,0xa90457f6]},mount:{offset:0xefa00,stack:0x50,words:[0xd503237f,0xd10143ff,0xa9017bfd,0xa9025ff8]}};
const SDK={
 fileRead:{offset:0x104ef0,symbol:'lfs_file_read',words:[0xb7f80762,0xb7f808e4,0xf9400469,0xeb09009f]},
 fileSize:{offset:0x105480,symbol:'lfs_file_size',words:[0xd503237f,0xd100c3ff,0xa9017bfd,0xa9024ff4]},
 fileRelease:{offset:0x104e10,symbol:'lfs_file_release',words:[0xd503237f,0xd100c3ff,0xa9017bfd,0xa9024ff4]},
 filesystemRelease:{offset:0x103390,symbol:'lfs_filesystem_release',words:[0xd503237f,0xd100c3ff,0xa9017bfd,0xa9024ff4]},
 storageRelease:{offset:0x107490,symbol:'lfs_storage_release',words:[0xd503237f,0xd100c3ff,0xa9017bfd,0xa9024ff4]},
 directoryRead:{offset:0x105800,symbol:'lfs_directory_read',words:[0xd503237f,0xd10103ff,0xa9017bfd,0xa90257f6]},
 directoryCount:{offset:0x1058f0,symbol:'lfs_directory_count',words:[0xd503237f,0xa9be7bfd,0xf9000bf3,0x910003fd]},
 directoryRelease:{offset:0x105720,symbol:'lfs_directory_release',words:[0xd503237f,0xd100c3ff,0xa9017bfd,0xa9024ff4]}
};
module.exports={ABI,SDK};
