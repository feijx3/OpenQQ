'use strict';
/**
 * OIDB 动作表 —— 把 SnowLuma 的 protobuf 定义搬过来，一个动作一行。
 *
 * 来源：`index.mjs` 里每个服务的 `__size_OidbBase__<Name>(obj, sizes)` 函数，
 * 其中 `const _fN = obj["键名"]` 的 N 就是 protobuf field 号（field = N+1）。
 * 字段号来自对协议实现的逐字段核对；非法输入由 pb-mini 直接抛错，不会编成 0。
 *
 * **schema 抽出来必须跟实测对照，不能盲信**。已知一处不符：
 *   `SendPoke` 抽出来是 `1:uin 2:groupUin 3:friendUin 4:ext`，
 *   但实测发出去的是 **field 5 / 6**（`08…10…2800 3000`），而且实测能通。
 *   所以拍一拍没走这张表，单独写在 sso-pipe.cjs 的 buildOidbPoke 里。
 *
 * 加一个动作 = 在 OIDB_ACTIONS 里加一行（wire + body schema + build）。
 * build 返回「按 schema 键名的对象」，通用编码器负责变成 protobuf 字节。
 */

const { varint: pbVarint, vint: pbVarintField, bytes: pbBytesField } = require('./pb-mini.cjs');

// ---- 通用编码器：按 schema 把对象编成 protobuf ----
// schema 形如 { 1: {name:'groupUin', kind:'varint'}, 2: {name:'settings', kind:'message', fields:{...}} }
function encodeBySchema(schema, values) {
  if (!values) return Buffer.alloc(0);
  // 直接给字节的（repeated 字段、手拼的包）：build 返回 { __raw: Buffer }
  if (Buffer.isBuffer(values.__raw)) return values.__raw;
  const parts = [];
  for (const [num, spec] of Object.entries(schema)) {
    const v = values[spec.name];
    if (v === undefined || v === null) continue;
    const fieldNo = Number(num);
    if (spec.kind === 'varint') {
      // proto3 默认值通常不编码，但有些字段的 0 本身就是有效值（"关闭"/"不启用"），
      // 省掉之后服务端会当成"这次请求没提到这一项"，于是只能开、关不掉。
      // 这类字段在 schema 里标 keepZero: true，强制把 0 写进 wire。
      if ((v === 0 || v === 0n || v === false) && spec.keepZero !== true) continue;
      parts.push(pbVarintField(fieldNo, v === false ? 0 : v));
    } else if (spec.kind === 'string') {
      if (v === '') continue;
      parts.push(pbBytesField(fieldNo, Buffer.from(String(v), 'utf8')));
    } else if (spec.kind === 'bytes') {
      const buf = Buffer.isBuffer(v) ? v : Buffer.from(v || []);
      if (!buf.length) continue;
      parts.push(pbBytesField(fieldNo, buf));
    } else if (spec.kind === 'message') {
      const inner = encodeBySchema(spec.fields, v);
      // 内层全被省略时外层通常也跳过；标了 keepZero 的要把空 message 也写出去，
      // 让服务端明确收到"这一组我确实按 0 处理"。
      if (!inner.length && spec.keepZero !== true) continue;
      parts.push(pbBytesField(fieldNo, inner));
    }
  }
  return Buffer.concat(parts);
}

// 把「内层 body」包成 OidbBase
// OidbBase { command=1, subCommand=2, errorCode=3, body=4, errorMsg=5, properties=6, reserved=7 }
function wrapOidbBase(command, subCommand, bodyBuf, reserved = 0) {
  const parts = [
    pbVarintField(1, command),
    pbVarintField(2, subCommand),
    pbVarintField(3, 0),
    pbBytesField(4, bodyBuf || Buffer.alloc(0)),
  ];
  // field 7 `reserved` 就是 SL 里的 `uinForm`：为 1 表示 body 里的账号用 uin 而不是 uid。
  //    SL 的 makeOidbEnvelope 写的是 `reserved: isUid ? 1 : 0`，而标了 `uinForm: true` 的服务都传 1。
  //    之前我们从不带这个字段 —— `send_tuwen_ark` 回 `30000 param error: client_info.platform`
  //    很可能就是缺它（服务端拿不到 uinForm 就走另一套 client_info 校验）。
  if (reserved) parts.push(pbVarintField(7, reserved));
  return Buffer.concat(parts);
}

// ---- 群设置共用的 settings 容器（0x89a_0）----
// 三种设置都走同一条 wire，只是 settings 里的字段不同。
const SETTINGS_SEARCH = {
  // 0 = 关闭（不用指纹 / 不用密码进群）。0 是有效值，必须显式写进 wire，否则这一项等于没提。
  1: { name: 'noFingerOpen', kind: 'varint', keepZero: true },
  2: { name: 'noCodeFingerOpen', kind: 'varint', keepZero: true },
};
const SETTINGS_INVITE = {
  1: { name: 'appPrivilegeFlag', kind: 'varint' },
  2: { name: 'appPrivilegeMask', kind: 'varint' },
  // 0 = 禁止成员邀请。靠 mask 定位这一位，但值本身也必须写出去。
  3: { name: 'allowMemberInvite', kind: 'varint', keepZero: true },
};
const SETTINGS_HISTORY = {
  // 0 = 新成员看不到历史消息。同样靠 mask 定位，值要显式写。
  1: { name: 'groupFlagExt4', kind: 'varint', keepZero: true },
  2: { name: 'groupFlagExt4Mask', kind: 'varint' },
};

/**
 * OIDB_ACTIONS：动作名 → { command, subCommand, wire, body, build }
 * body 是内层 schema；build(params) 返回按 schema 键名的对象。
 * danger: true 表示「不可撤回且影响他人」——默认只构造、不真发。
 */
const OIDB_ACTIONS = {
  // ---- 群设置：0x89a_0 ----
  set_group_search: {
    command: 2202, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x89a_0',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'settings', kind: 'message', fields: SETTINGS_SEARCH },
      3: { name: 'field12', kind: 'varint' },
    },
    build: (p) => ({
      groupUin: p.group_id,
      settings: {
        // SL 的入参是 no_finger_open / no_code_finger_open（布尔），映射成 1/0
        noFingerOpen: p.no_finger_open ? 1 : 0,
        noCodeFingerOpen: p.no_code_finger_open ? 1 : 0,
      },
      field12: 0,
    }),
  },

  set_group_new_member_history_visibility: {
    command: 2202, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x89a_0',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'settings', kind: 'message', fields: SETTINGS_HISTORY },
      3: { name: 'field12', kind: 'varint' },
    },
    build: (p) => ({
      groupUin: p.group_id,
      // SL: groupFlagExt4 = visible ? 4 : 0, mask 固定 4
      settings: { groupFlagExt4: p.visible ? 4 : 0, groupFlagExt4Mask: 4 },
      field12: 0,
    }),
  },

  set_group_member_invite_policy: {
    command: 2202, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x89a_0',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'settings', kind: 'message', fields: SETTINGS_INVITE },
      3: { name: 'field12', kind: 'varint' },
    },
    // policy: disabled / require_approval / no_approval / no_approval_under_100
    // allowMemberInvite = policy==='disabled' ? 0 : 1；权限位由 currentPrivilegeFlag 合并，
    // 我们拿不到当前值，所以 appPrivilegeFlag 先只带 allowMemberInvite 对应的位，
    // 掩码只覆盖这一位，避免把别的设置一起改掉。
    build: (p) => {
      const policy = String(p.policy || '');
      const allow = policy === 'disabled' ? 0 : 1;
      return {
        groupUin: p.group_id,
        settings: {
          appPrivilegeFlag: allow ? 2 : 0,
          appPrivilegeMask: 2,
          allowMemberInvite: allow,
        },
        field12: 0,
      };
    },
  },

  // ---- 群待办：0x9474_0（只读）----
  get_group_todo_list: {
    command: 38004, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x9474_0',
    body: {
      1: { name: 'groupId', kind: 'varint' },
      2: { name: 'bannerFlag', kind: 'varint' },
    },
    build: (p) => ({ groupId: p.group_id, bannerFlag: p.banner_flag ?? 1 }),
  },

  // ---- 管理员权限：0x9164_2（只读）/ 0x9c1c_2（写，影响他人）----
  get_group_admin_permissions: {
    command: 37220, subCommand: 2, wire: 'OidbSvcTrpcTcp.0x9164_2',
    body: {
      1: { name: 'groupCode', kind: 'varint' },
      2: { name: 'memberUins', kind: 'bytes' },
      3: { name: 'filter', kind: 'message', fields: { 1: { name: 'permissions', kind: 'bytes' } } },
    },
    build: (p) => ({
      groupCode: p.group_id,
      // repeated uint64 是 packed：一串 varint 拼起来
      memberUins: Buffer.concat([pbVarint(p.user_id)]),
      filter: { permissions: Buffer.from([1]) },
    }),
  },

  set_group_admin_permissions: {
    command: 39964, subCommand: 2, wire: 'OidbSvcTrpcTcp.0x9c1c_2',
    danger: true,
    body: {
      1: { name: 'groupCode', kind: 'varint' },
      2: { name: 'memberUin', kind: 'varint' },
      3: { name: 'permissions', kind: 'bytes' },
    },
    build: (p) => ({
      groupCode: p.group_id,
      memberUin: p.user_id,
      permissions: Buffer.from(Array.isArray(p.permissions) ? p.permissions : [], 'utf8'),
    }),
  },

  // ---- 闪传文件改名：0x9427_0 ----
  rename_flash_file: {
    command: 37927, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x9427_0',
    body: {
      1: { name: 'filesetUuid', kind: 'string' },
      2: { name: 'name', kind: 'message', fields: { 1: { name: 'newName', kind: 'string' }, 2: { name: 'displayName', kind: 'string' } } },
      3: { name: 'flag', kind: 'message', fields: { 1: { name: 'field1', kind: 'varint' } } },
    },
    build: (p) => ({
      filesetUuid: p.fileset_uuid,
      name: { newName: p.new_name, displayName: p.new_name },
      flag: { field1: 0 },
    }),
  },

  // ==================== 第二批（，一次接 10 个）====================
  // 字段号均已逐字段核对；标了 danger 的默认只构造不真发。

  // ---- 群名片 / 头衔：0x8fc_3 / 0x8fc_2（可撤回，改回即可）----
  set_member_card: {
    command: 2300, subCommand: 3, wire: 'OidbSvcTrpcTcp.0x8fc_3',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'body', kind: 'message', fields: { 1: { name: 'targetUid', kind: 'string' }, 2: { name: 'targetName', kind: 'string' } } },
    },
    build: (p) => ({ groupUin: p.group_id, body: { targetUid: p.user_id, targetName: p.card ?? '' } }),
  },

  set_special_title: {
    command: 2300, subCommand: 2, wire: 'OidbSvcTrpcTcp.0x8fc_2',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'body', kind: 'message', fields: {
        1: { name: 'targetUid', kind: 'string' },
        2: { name: 'specialTitle', kind: 'string' },
        3: { name: 'expireTime', kind: 'varint' },
        4: { name: 'uinName', kind: 'string' },
      } },
    },
    build: (p) => ({ groupUin: p.group_id, body: { targetUid: p.user_id, specialTitle: p.special_title ?? '', expireTime: p.expire_time ?? -1, uinName: '' } }),
  },

  // ---- 群签到：0xeb7_1 ----
  set_group_sign: {
    command: 3767, subCommand: 1, wire: 'OidbSvcTrpcTcp.0xeb7_1',
    body: {
      1: { name: 'signInInfo', kind: 'message', fields: {
        1: { name: 'uin', kind: 'string' },
        2: { name: 'groupId', kind: 'string' },
        3: { name: 'version', kind: 'string' },
      } },
    },
    build: (p) => ({ signInInfo: { uin: String(p.uin ?? ''), groupId: String(p.group_id), version: String(p.version ?? '') } }),
  },

  // ---- 群文件空间（只读）：0x6d8_3 ----
  get_group_file_space: {
    command: 1752, subCommand: 3, wire: 'OidbSvcTrpcTcp.0x6d8_3',
    body: {
      1: { name: 'count', kind: 'message', fields: {
        1: { name: 'groupUin', kind: 'varint' },
        2: { name: 'appId', kind: 'varint' },
        3: { name: 'busId', kind: 'varint' },
      } },
      2: { name: 'space', kind: 'message', fields: {
        1: { name: 'groupUin', kind: 'varint' },
        2: { name: 'appId', kind: 'varint' },
      } },
    },
    build: (p) => ({ count: { groupUin: p.group_id, appId: 7, busId: 102 }, space: { groupUin: p.group_id, appId: 7 } }),
  },

  // ---- 群文件夹：0x6d7_0 / 0x6d7_1 / 0x6d7_2 ----
  create_group_file_folder: {
    command: 1751, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x6d7_0',
    body: {
      1: { name: 'create', kind: 'message', fields: {
        1: { name: 'groupUin', kind: 'varint' },
        2: { name: 'rootDirectory', kind: 'string' },
        3: { name: 'folderName', kind: 'string' },
      } },
    },
    build: (p) => ({ create: { groupUin: p.group_id, rootDirectory: String(p.parent_id ?? '/'), folderName: String(p.folder_name ?? p.name ?? '') } }),
  },

  delete_group_folder: {
    command: 1751, subCommand: 1, wire: 'OidbSvcTrpcTcp.0x6d7_1',
    body: {
      2: { name: 'delete', kind: 'message', fields: {
        1: { name: 'groupUin', kind: 'varint' },
        2: { name: 'folderId', kind: 'string' },
      } },
    },
    build: (p) => ({ delete: { groupUin: p.group_id, folderId: String(p.folder_id ?? p.folder ?? '') } }),
    danger: true,
  },

  rename_group_file_folder: {
    command: 1751, subCommand: 2, wire: 'OidbSvcTrpcTcp.0x6d7_2',
    body: {
      3: { name: 'rename', kind: 'message', fields: {
        1: { name: 'groupUin', kind: 'varint' },
        2: { name: 'folderId', kind: 'string' },
        3: { name: 'newFolderName', kind: 'string' },
      } },
    },
    build: (p) => ({ rename: { groupUin: p.group_id, folderId: String(p.folder_id ?? p.folder ?? ''), newFolderName: String(p.new_name ?? p.name ?? '') } }),
  },

  // ---- 危险动作（默认只构造不发送，需 confirm_danger: true）----
  set_group_kick_members: {
    command: 2208, subCommand: 1, wire: 'OidbSvcTrpcTcp.0x8a0_1',
    body: {
      1: { name: 'groupId', kind: 'varint' },
      2: { name: 'targetUids', kind: 'bytes' },
      3: { name: 'rejectAddRequest', kind: 'varint' },
      4: { name: 'kickReason', kind: 'bytes' },
      5: { name: 'field12', kind: 'varint' },
    },
    build: (p) => ({
      groupId: p.group_id,
      targetUids: Buffer.from(String(p.user_id ?? ''), 'utf8'),
      rejectAddRequest: p.reject_add_request ? 1 : 0,
      kickReason: Buffer.from(String(p.reason ?? ''), 'utf8'),
    }),
    danger: true,
  },

  set_group_admin: {
    command: 4246, subCommand: 1, wire: 'OidbSvcTrpcTcp.0x1096_1',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'uid', kind: 'string' },
      3: { name: 'isAdmin', kind: 'varint' },
    },
    build: (p) => ({ groupUin: p.group_id, uid: String(p.user_id ?? ''), isAdmin: p.enable ? 1 : 0 }),
    danger: true,
  },

  // set_group_name 不在这里：`native/admin.cjs` 有 `case 'set_group_name'`
  //    （走 groups.modifyGroupName），它比这张表更早执行，实测能真改群名。
  //    这里再放一份只会造成「以为走 OIDB、实际走内核」的混淆，已经删掉。

  // ==================== 第三批（，补完剩余）====================

  // ---- 群文件列表（读）—— 之前文件类功能是单向的，就缺这个 ----
  get_group_files_page: {
    command: 1752, subCommand: 1, wire: 'OidbSvcTrpcTcp.0x6d8_1',
    body: {
      1: { name: 'list', kind: 'message', fields: {
        1: { name: 'groupUin', kind: 'varint' },
        2: { name: 'appId', kind: 'varint' },
        3: { name: 'targetDirectory', kind: 'string' },
        4: { name: 'fileCount', kind: 'varint' },
        5: { name: 'sortBy', kind: 'varint' },
        6: { name: 'startIndex', kind: 'varint' },
        7: { name: 'field17', kind: 'varint' },
        8: { name: 'field18', kind: 'varint' },
      } },
    },
    build: (p) => ({
      list: {
        groupUin: p.group_id,
        appId: 7,
        targetDirectory: String(p.folder_id ?? p.folder ?? '/'),
        fileCount: Number(p.count ?? 50),
        sortBy: 1,
        startIndex: Number(p.start ?? 0),
        field17: 1,
        field18: 1,
      },
    }),
  },

  // ---- 群文件删除：0x6d6_3（oneof field 3）----
  delete_group_file: {
    command: 1750, subCommand: 3, wire: 'OidbSvcTrpcTcp.0x6d6_3',
    body: {
      3: { name: 'delete', kind: 'message', fields: {
        1: { name: 'groupUin', kind: 'varint' },
        2: { name: 'busId', kind: 'varint' },
        3: { name: 'fileId', kind: 'string' },
      } },
    },
    build: (p) => ({ delete: { groupUin: p.group_id, busId: 102, fileId: String(p.file_id ?? '') } }),
    danger: true,
  },

  // ---- 群成员权限：0x89a_0（settings 变体，只有 flag+mask）----
  set_group_member_permissions: {
    command: 2202, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x89a_0',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'settings', kind: 'message', fields: {
        1: { name: 'appPrivilegeFlag', kind: 'varint', keepZero: true },
        2: { name: 'appPrivilegeMask', kind: 'varint' },
      } },
      3: { name: 'field12', kind: 'varint' },
    },
    build: (p) => ({
      groupUin: p.group_id,
      settings: { appPrivilegeFlag: Number(p.flag ?? 0), appPrivilegeMask: Number(p.mask ?? 0) },
      field12: 0,
    }),
  },

  // ---- 全员禁言：0x89a_0（muteState）----
  set_group_whole_mute: {
    command: 2202, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x89a_0',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'muteState', kind: 'message', fields: { 1: { name: 'state', kind: 'varint' } } },
    },
    // ⚠️ 不能走 schema 编码：state:0（关闭禁言）会被 encodeBySchema 当成 proto3 默认值跳过，
    //    而外层 message 见内层为空又整块跳过 —— 结果 body 里只剩 groupUin，
    //    服务端收到的请求根本没提 muteState，"关闭全员禁言"永远发不出去。
    //    这正是「群被永久禁言、怎么关都关不掉」的成因。这里手拼字节，让 0 显式出现在 wire 上。
    build: (p) => {
      const state = p.enable === true || p.enable === 1 || p.enable === '1' || p.enable === 'true' ? 1 : 0;
      return {
        __raw: Buffer.concat([
          pbVarintField(1, p.group_id),
          pbBytesField(2, pbVarintField(1, state)),
        ]),
      };
    },
    danger: true,
  },

  // ---- 加群方式：0x89a_0（addType / question / answer）----
  set_group_add_option: {
    command: 2202, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x89a_0',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'settings', kind: 'message', fields: {
        1: { name: 'addType', kind: 'varint', keepZero: true },
        2: { name: 'groupQuestion', kind: 'string' },
        3: { name: 'groupAnswer', kind: 'string' },
      } },
      3: { name: 'field12', kind: 'varint' },
    },
    build: (p) => ({
      groupUin: p.group_id,
      settings: {
        addType: Number(p.add_type ?? 0),
        groupQuestion: String(p.question ?? ''),
        groupAnswer: String(p.answer ?? ''),
      },
      field12: 0,
    }),
    danger: true,
  },

  // ---- 禁言单个成员：0x1253_1 ----
  mute_group_member: {
    command: 4691, subCommand: 1, wire: 'OidbSvcTrpcTcp.0x1253_1',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'type', kind: 'varint', keepZero: true },   // 0 = 解除禁言，是有效值不是默认值
      3: { name: 'body', kind: 'message', fields: {
        1: { name: 'targetUid', kind: 'string' },
        2: { name: 'duration', kind: 'varint' },
      } },
    },
    build: (p) => ({
      groupUin: p.group_id,
      type: p.enable === false ? 0 : 1,
      body: { targetUid: String(p.user_id ?? ''), duration: Number(p.duration ?? 60) },
    }),
    danger: true,
  },

  // ---- 退群：0x1097_1 ----
  leave_group: {
    command: 4247, subCommand: 1, wire: 'OidbSvcTrpcTcp.0x1097_1',
    body: { 1: { name: 'groupUin', kind: 'varint' } },
    build: (p) => ({ groupUin: p.group_id }),
    danger: true,
  },

  // ---- 好友请求处理：0xb5d_44 ----
  handle_friend_request: {
    command: 2909, subCommand: 44, wire: 'OidbSvcTrpcTcp.0xb5d_44',
    body: {
      1: { name: 'accept', kind: 'varint' },
      2: { name: 'targetUid', kind: 'string' },
    },
    build: (p) => ({ accept: p.approve ? 1 : 0, targetUid: String(p.flag ?? p.user_id ?? '') }),
    danger: true,
  },

  // ---- 点赞：0x7e5_104 ----
  send_like: {
    command: 2021, subCommand: 104, wire: 'OidbSvcTrpcTcp.0x7e5_104',
    body: {
      1: { name: 'targetUid', kind: 'string' },
      2: { name: 'sourceId', kind: 'varint' },
      3: { name: 'count', kind: 'varint' },
    },
    build: (p) => ({ targetUid: String(p.user_id ?? ''), sourceId: 0, count: Math.min(20, Math.max(1, Number(p.times ?? 1))) }),
  },

  // ---- 图片 OCR：0xe07_0 ----
  image_ocr: {
    command: 3591, subCommand: 0, wire: 'OidbSvcTrpcTcp.0xe07_0',
    body: {
      1: { name: 'version', kind: 'varint' },
      2: { name: 'client', kind: 'varint' },
      3: { name: 'entrance', kind: 'varint' },
      4: { name: 'ocrReqBody', kind: 'message', fields: {
        1: { name: 'imageUrl', kind: 'string' },
        2: { name: 'languageType', kind: 'varint' },
        3: { name: 'scene', kind: 'varint' },
      } },
    },
    build: (p) => ({
      version: 1, client: 1, entrance: 1,
      ocrReqBody: { imageUrl: String(p.image_url ?? p.url ?? ''), languageType: 0, scene: 1 },
    }),
  },

  // ---- 输入状态：0xcd4_1（用 OIDB 重做，绕开内核那条回 316 的）----
  set_input_status: {
    command: 3284, subCommand: 1, wire: 'OidbSvcTrpcTcp.0xcd4_1',
    body: {
      1: { name: 'reqBody', kind: 'message', fields: {
        1: { name: 'uid', kind: 'string' },
        2: { name: 'chatType', kind: 'varint' },
        3: { name: 'eventType', kind: 'varint' },
      } },
    },
    // eventType: 1=正在输入, 2=取消
    build: (p) => ({
      reqBody: {
        uid: String(p.uid ?? p.openqq_ref?.peerUid ?? ''),
        chatType: p.group_id ? 2 : 1,
        eventType: Number(p.event_type ?? 1),
      },
    }),
  },

  // ---- 拿 pskey：0x102a_0（QZone 等网页接口的凭据）----
  get_pskey: {
    command: 4138, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x102a_0',
    body: { 1: { name: 'domainList', kind: 'bytes' } },
    build: (p) => {
      const d = String(p.domain ?? p.domains ?? 'qzone.qq.com');
      // repeated string：一个字段一包，多个域名要拼多次
      const parts = d.split(',').map((x) => pbBytesField(1, Buffer.from(x.trim(), 'utf8')));
      return { __raw: Buffer.concat(parts) };
    },
  },

  // ---- 收藏表情：0x902e_1 改 / 0x902f_1 置顶 ----
  modify_custom_face: {
    command: 36910, subCommand: 1, wire: 'OidbSvcTrpcTcp.0x902e_1',
    body: {
      1: { name: 'field1', kind: 'varint' },
      2: { name: 'osVersion', kind: 'string' },
      3: { name: 'opType', kind: 'varint' },
      4: { name: 'entry', kind: 'message', fields: {
        1: { name: 'emoji', kind: 'message', fields: {
          1: { name: 'emojiId', kind: 'string' },
          2: { name: 'md5', kind: 'string' },
        } },
        2: { name: 'desc', kind: 'string' },
      } },
      5: { name: 'field12', kind: 'varint' },
    },
    build: (p) => ({
      field1: 1, osVersion: '9.9.37', opType: Number(p.op_type ?? 1),
      entry: { emoji: { emojiId: String(p.emoji_id ?? ''), md5: String(p.md5 ?? '') }, desc: String(p.desc ?? '') },
      field12: 0,
    }),
  },

  move_custom_face_to_front: {
    command: 36911, subCommand: 1, wire: 'OidbSvcTrpcTcp.0x902f_1',
    body: {
      1: { name: 'env', kind: 'message', fields: {
        1: { name: 'field1', kind: 'varint' },
        2: { name: 'osVersion', kind: 'string' },
        3: { name: 'buildVersion', kind: 'string' },
      } },
      2: { name: 'emojiId', kind: 'string' },
      3: { name: 'position', kind: 'varint' },
    },
    build: (p) => ({
      env: { field1: 1, osVersion: '9.9.37', buildVersion: '9.9.37' },
      emojiId: String(p.emoji_id ?? ''),
      position: Number(p.position ?? 0),
    }),
  },

  // ==================== 第四批（，补完）====================

  // ---- 群待办：0xf90_1/2/3 —— SL 用 ACTION_TO_SUBCMD = {set:1, complete:2, cancel:3} 区分 ----
  set_group_todo: {
    command: 3984, subCommand: 1, wire: 'OidbSvcTrpcTcp.0xf90_1',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'msgSeq', kind: 'varint' },
    },
    build: (p) => ({ groupUin: p.group_id, msgSeq: Number(p.msg_seq ?? p.message_id ?? p.msg_id ?? 0) }),
  },

  complete_group_todo: {
    command: 3984, subCommand: 2, wire: 'OidbSvcTrpcTcp.0xf90_2',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'msgSeq', kind: 'varint' },
    },
    build: (p) => ({ groupUin: p.group_id, msgSeq: Number(p.msg_seq ?? p.message_id ?? p.msg_id ?? 0) }),
  },

  cancel_group_todo: {
    command: 3984, subCommand: 3, wire: 'OidbSvcTrpcTcp.0xf90_3',
    body: {
      1: { name: 'groupUin', kind: 'varint' },
      2: { name: 'msgSeq', kind: 'varint' },
    },
    build: (p) => ({ groupUin: p.group_id, msgSeq: Number(p.msg_seq ?? p.message_id ?? p.msg_id ?? 0) }),
    danger: true,
  },

  // ---- 群文件改名 / 移动 / 取下载链接：0x6d6_4 / 0x6d6_5 / 0x6d6_2 ----
  // 内层字段号是按 SL serialize 的键顺序推的（这三条的 __size_ 函数名带 $N 后缀，抽不到），
  //    第一次实测若回 145 就按报错里的字段名调。
  rename_group_file: {
    command: 1750, subCommand: 4, wire: 'OidbSvcTrpcTcp.0x6d6_4',
    body: {
      4: { name: 'rename', kind: 'message', fields: {
        1: { name: 'groupUin', kind: 'varint' },
        2: { name: 'busId', kind: 'varint' },
        3: { name: 'fileId', kind: 'string' },
        4: { name: 'parentFolder', kind: 'string' },
        5: { name: 'newFileName', kind: 'string' },
      } },
    },
    build: (p) => ({
      rename: {
        groupUin: p.group_id, busId: 102,
        fileId: String(p.file_id ?? ''),
        parentFolder: String(p.parent_folder ?? p.folder_id ?? '/'),
        newFileName: String(p.new_name ?? p.name ?? ''),
      },
    }),
  },

  move_group_file: {
    command: 1750, subCommand: 5, wire: 'OidbSvcTrpcTcp.0x6d6_5',
    body: {
      5: { name: 'move', kind: 'message', fields: {
        1: { name: 'groupUin', kind: 'varint' },
        2: { name: 'appId', kind: 'varint' },
        3: { name: 'busId', kind: 'varint' },
        4: { name: 'fileId', kind: 'string' },
        5: { name: 'parentDirectory', kind: 'string' },
        6: { name: 'targetDirectory', kind: 'string' },
      } },
    },
    build: (p) => ({
      move: {
        groupUin: p.group_id, appId: 7, busId: 102,
        fileId: String(p.file_id ?? ''),
        parentDirectory: String(p.parent_folder ?? p.folder_id ?? '/'),
        targetDirectory: String(p.target_folder ?? p.target_id ?? '/'),
      },
    }),
    danger: true,
  },

  get_group_file_url: {
    command: 1750, subCommand: 2, wire: 'OidbSvcTrpcTcp.0x6d6_2',
    body: {
      2: { name: 'download', kind: 'message', fields: {
        1: { name: 'groupUin', kind: 'varint' },
        2: { name: 'appId', kind: 'varint' },
        3: { name: 'busId', kind: 'varint' },
        4: { name: 'fileId', kind: 'string' },
      } },
    },
    build: (p) => ({ download: { groupUin: p.group_id, appId: 7, busId: Number(p.bus_id ?? 102), fileId: String(p.file_id ?? '') } }),
  },
  // ══ 群相册：走 trpc 命令，不是 OIDB ══════════════════════════
  // SL 的 GroupAlbumApi 用 ctx.sendRawPacket(CMD, body)；CMD 是 trpc 服务名字符串。
  // 我们的 sso_pipe_send 本来就支持任意 cmd，所以 `raw: true` + `wire` 用 trpc 名即可。
  // 三个坑：空 body 回 `1006504 发送异常!`；groupId 必须编成 string（varint 会回 `10000 参数错误，群ID不能为空`）；
  //           seq 必须是 3331。
  get_group_album_list: {
    command: 0, subCommand: 0, raw: true,
    wire: 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetAlbumList',
    body: {},
    build: (p) => {
      const enc = require('./pb-mini.cjs');
      const gid = String(p.group_id ?? '');
      const data = Buffer.concat([enc.str(1, gid), enc.bytes(2, Buffer.alloc(0))]);
      const ext = Buffer.concat([enc.str(1, 'fc-appid'), enc.str(2, '100')]);
      return { __raw: Buffer.concat([
        enc.vint(1, 3331),
        enc.bytes(2, Buffer.alloc(0)),
        enc.bytes(3, Buffer.alloc(0)),
        enc.bytes(4, data),
        enc.str(5, `_${Date.now()}_${Math.floor(Math.random() * 1e5)}`),
        enc.bytes(6, ext),
      ]) };
    },
  },
  get_group_album_media: {
    command: 0, subCommand: 0, raw: true,
    wire: 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList',
    body: {},
    build: (p) => {
      const enc = require('./pb-mini.cjs');
      // 照 SL 的 getMediaList 逐字段复刻：
      // GetMediaListRequest { 1:field1=0, 2:field2=空bytes, 3:field3=空bytes,
      //   4:reqInfo{1:groupId(str), 2:albumId(str), 3:field3=0, 4:field4="", 5:pageInfo(str)},
      //   5:traceId=`_<ms>_<rand>`, 6:extMap[{1:"fc-appid",2:"100"}] }
      const reqInfo = Buffer.concat([
        enc.str(1, String(p.group_id ?? '')),
        enc.str(2, String(p.album_id ?? '')),
        enc.vint(3, 0),
        enc.str(4, ''),
        enc.str(5, String(p.attach_info ?? p.page_info ?? '')),
      ]);
      const ext = Buffer.concat([enc.str(1, 'fc-appid'), enc.str(2, '100')]);
      return { __raw: Buffer.concat([
        enc.vint(1, 0),
        enc.bytes(2, Buffer.alloc(0)),
        enc.bytes(3, Buffer.alloc(0)),
        enc.bytes(4, reqInfo),
        enc.str(5, `_${Date.now()}_${Math.floor(Math.random() * 1e5)}`),
        enc.bytes(6, ext),
      ]) };
    },
  },
  del_group_album_media: {
    command: 0, subCommand: 0, raw: true, danger: true,
    wire: 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.DeleteMedias',
    body: {},
    build: (p) => {
      const enc = require('./pb-mini.cjs');
      // 照 SL 的 groupAlbum.delete 逐字段复刻：
      // DeleteMediasRequest { 1:field1=8694, 2:"h5_test", 3:"h5_test",
      //   4:body{1:groupId(str), 2:albumId(str), 3:mediaIds(repeated str), 4:batchIds(repeated str,可选)},
      //   5:traceId=`<uin>_<ms>_<rand>`, 6:extMap[{1:"fc-appid",2:"100"}] }
      // 判据（SL 同款）：resp.field1 必须 === 8694 且 resp.field2(errCode) 为 0。
      const gid = String(p.group_id ?? '');
      const album = String(p.album_id ?? '');
      const ids = Array.isArray(p.media_ids) ? p.media_ids.map(String)
        : (p.media_id ? [String(p.media_id)] : []);
      if (!ids.length) throw new Error('del_group_album_media 需要 media_id 或 media_ids');
      const inner = Buffer.concat([
        enc.str(1, gid), enc.str(2, album),
        ...ids.map((x) => enc.str(3, x)),
        ...(p.batch_id ? [enc.str(4, String(p.batch_id))] : []),
      ]);
      const ext = Buffer.concat([enc.str(1, 'fc-appid'), enc.str(2, '100')]);
      return { __raw: Buffer.concat([
        enc.vint(1, 8694), enc.str(2, 'h5_test'), enc.str(3, 'h5_test'),
        enc.bytes(4, inner),
        enc.str(5, `${p.uin ?? ''}_${Date.now()}_${Math.floor(Math.random() * 1e5)}`),
        enc.bytes(6, ext),
      ]) };
    },
  },
  do_group_album_comment: {
    command: 0, subCommand: 0, raw: true,
    wire: 'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunComment',
    body: {},
    build: (p) => {
      const enc = require('./pb-mini.cjs');
      return { __raw: enc.str(5, `_${Date.now()}_${Math.floor(Math.random() * 1e5)}`) };
    },
  },
  set_group_album_media_like: {
    command: 0, subCommand: 0, raw: true,
    wire: 'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunLike',
    body: {},
    build: (p) => {
      const enc = require('./pb-mini.cjs');
      return { __raw: enc.str(1, String(p.group_id ?? '')) };
    },
  },
  cancel_group_album_media_like: {
    command: 0, subCommand: 0, raw: true,
    wire: 'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunLike',
    body: {},
    build: (p) => {
      const enc = require('./pb-mini.cjs');
      return { __raw: Buffer.concat([enc.str(1, String(p.group_id ?? '')), enc.vint(2, 0)]) };
    },
  },
  // ══ Ark 卡片：从 SL 的 ContactsApi 抽出的 OIDB 服务 ═══════
  // GetBuddyRecommendArk: 4790 = 0x12b6_0，serialize {uin, phoneNumber, jumpUrl}
  // GetGroupRecommendArk: 2231 = 0x8b7_5，serialize {reqType:1, groupCode, flag:1}
  // 注意：这两个在 SL 里是 readOnly 的——**只生成 Ark 卡片 JSON 返回，不发送**。
  get_buddy_recommend_ark: {
    command: 4790, subCommand: 0, wire: 'OidbSvcTrpcTcp.0x12b6_0',
    body: {
      1: { name: 'uin', kind: 'varint' },
      2: { name: 'phoneNumber', kind: 'string' },
      3: { name: 'jumpUrl', kind: 'string' },
    },
    build: (p) => {
      const uin = String(p.user_id ?? p.uin ?? '');
      return { uin, phoneNumber: String(p.phone_number ?? '') || '-',
        jumpUrl: `mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=${uin}` };
    },
  },
  get_group_recommend_ark: {
    command: 2231, subCommand: 5, wire: 'OidbSvcTrpcTcp.0x8b7_5',
    body: {
      1: { name: 'reqType', kind: 'varint' },
      2: { name: 'groupCode', kind: 'varint' },
      3: { name: 'flag', kind: 'varint' },
    },
    build: (p) => ({ reqType: 1, groupCode: p.group_id, flag: 1 }),
  },
  // share_peer / share_group_ex / share_ark_share / send_group_ark_share 都是上面两个的别名语义
  share_group_ex: {
    command: 2231, subCommand: 5, wire: 'OidbSvcTrpcTcp.0x8b7_5',
    body: {
      1: { name: 'reqType', kind: 'varint' },
      2: { name: 'groupCode', kind: 'varint' },
      3: { name: 'flag', kind: 'varint' },
    },
    build: (p) => ({ reqType: 1, groupCode: p.group_id, flag: 1 }),
  },
  send_group_ark_share: {
    command: 2231, subCommand: 5, wire: 'OidbSvcTrpcTcp.0x8b7_5',
    body: {
      1: { name: 'reqType', kind: 'varint' },
      2: { name: 'groupCode', kind: 'varint' },
      3: { name: 'flag', kind: 'varint' },
    },
    build: (p) => ({ reqType: 1, groupCode: p.group_id, flag: 1 }),
  },
  // share_peer：SL 里是「按 user_id 或 group_id 二选一生成 Ark」，这里两个目标都走同一条，
  // 具体哪个由参数决定（group_id 优先，和 SL 的 if 顺序一致）。
  share_peer: {
    command: 2231, subCommand: 5, wire: 'OidbSvcTrpcTcp.0x8b7_5',
    body: {
      1: { name: 'reqType', kind: 'varint' },
      2: { name: 'groupCode', kind: 'varint' },
      3: { name: 'flag', kind: 'varint' },
    },
    build: (p) => ({ reqType: 1, groupCode: p.group_id ?? p.user_id, flag: 1 }),
  },
  // send_tuwen_ark —— 3522 = 0xdc2_34。三层嵌套，字段号从 SL 的 __write_* 抽：
  // Oidb0xdc2_34Req { 1:appInfo 2:meta }
  // Oidb0xdc2AppInfo { 1:appId 2:field2 3:field3 4:field5{1:field1} 5:targetId 6:content }
  // Oidb0xdc2CardContent { 1:flag 2:title 3:desc 4:summary 5:jumpUrl 6:previewUrl }
  // Oidb0xdc2Meta { 1:peerType 2:targetId }
  // TUWEN_ARK_APPID = 100446242（写死，SL 同值）
  send_tuwen_ark: {
    command: 3522, subCommand: 34, wire: 'OidbSvcTrpcTcp.0xdc2_34',
    uinForm: true,
    body: {
      1: { name: 'appInfo', kind: 'message', fields: {
        1: { name: 'appId', kind: 'varint' },
        2: { name: 'field2', kind: 'varint' },
        3: { name: 'field3', kind: 'varint' },
        4: { name: 'field5', kind: 'message', fields: { 1: { name: 'field1', kind: 'varint' } } },
        5: { name: 'targetId', kind: 'varint' },
        6: { name: 'content', kind: 'message', fields: {
          1: { name: 'flag', kind: 'varint' },
          2: { name: 'title', kind: 'string' },
          3: { name: 'desc', kind: 'string' },
          4: { name: 'summary', kind: 'string' },
          5: { name: 'jumpUrl', kind: 'string' },
          6: { name: 'previewUrl', kind: 'string' },
        } },
      } },
      2: { name: 'meta', kind: 'message', fields: {
        1: { name: 'peerType', kind: 'varint' },
        2: { name: 'targetId', kind: 'varint' },
      } },
    },
    build: (p) => {
      const isGroup = p.group_id !== undefined && p.group_id !== null;
      const target = isGroup ? p.group_id : p.user_id;
      return {
        appInfo: {
          appId: 100446242, field2: 1, field3: 0, field5: { field1: 1 },
          targetId: target,
          content: {
            flag: 1,
            title: String(p.title ?? ''),
            desc: String(p.desc ?? ''),
            summary: String(p.summary ?? '[分享]'),
            jumpUrl: String(p.jump_url ?? p.jumpUrl ?? ''),
            previewUrl: String(p.preview_url ?? p.previewUrl ?? ''),
          },
        },
        // peerType: 1 = 群，2 = 好友（SL 里 p.peerType 由调用方给；这里按目标推导）
        meta: { peerType: isGroup ? 1 : 2, targetId: target },
      };
    },
  },
  // ══ 设置管理员接收加群验证（，从 SL 的 SetAdminReceiveVerify 抽出）══
  // command 2308 = 0x904，subCommand 1，SL 里 uinForm: true
  // SetGroupAdminReceiveVerifyRequest { 1: groupCode, 2: operation }
  // GroupAdminReceiveVerifyOperation { 1: adminUins(repeated) 2: authority 3: operate }
  // 之前走内核 Group.setRcvJoinVerifyMsg 一直回 1281 "no admin uins" —— 那条路字段名不对，正解是这条 OIDB。
  set_group_admin_receive_verify: {
    command: 2308, subCommand: 1, wire: 'OidbSvcTrpcTcp.0x904_1',
    body: {
      1: { name: 'groupCode', kind: 'varint' },
      2: { name: 'operation', kind: 'message', fields: {
        1: { name: 'adminUins', kind: 'varint' },
        2: { name: 'authority', kind: 'varint' },
        3: { name: 'operate', kind: 'varint' },
      } },
    },
    build: (p) => {
      const uid = p.user_id ?? p.uin ?? 0;
      return {
        groupCode: p.group_id,
        operation: {
          // repeated 字段，但 encodeBySchema 一次只编一个值 —— 传数组会让 pb.varint 抛 TypeError。
          // 这个动作本来就是单成员操作（给一个人开/关管理员接收验证），传单值即可。
          adminUins: Number(uid),
          authority: 1,
          operate: p.enable === undefined ? 1 : (Boolean(p.enable) ? 1 : 0),
        },
      };
    },
  },
  // ══ 设置群机器人加群选项（，从 SL 的 ModifyGroupExtInfo 抽出）══
  // command 3840 = 0xf00，subCommand 3，SL 里 uinForm: true
  // OidbModifyGroupExtReq { 1: groupCode, 2: info }
  // OidbGroupExtInfo      { 1: groupCode, 2: ext }
  // OidbGroupExtBody      { 1: inviteRobotMemberSwitch, 2: inviteRobotMemberExamine }
  // 之前走内核 Group.setGroupChatManageRobotSwitch 回 21000 服务异常 —— 正解是这条 OIDB。
  set_group_robot_add_option: {
    command: 3840, subCommand: 3, wire: 'OidbSvcTrpcTcp.0xf00_3',
    body: {
      1: { name: 'groupCode', kind: 'varint' },
      2: { name: 'info', kind: 'message', fields: {
        1: { name: 'groupCode', kind: 'varint' },
        2: { name: 'ext', kind: 'message', fields: {
          1: { name: 'inviteRobotMemberSwitch', kind: 'varint' },
          2: { name: 'inviteRobotMemberExamine', kind: 'varint' },
        } },
      } },
    },
    build: (p) => {
      const g = p.group_id;
      const sw = p.robot_member_switch ?? p.switch ?? (p.enable === undefined ? 1 : (p.enable ? 1 : 0));
      const ex = p.robot_member_examine ?? p.examine ?? 1;
      return { groupCode: g, info: { groupCode: g, ext: { inviteRobotMemberSwitch: Number(sw), inviteRobotMemberExamine: Number(ex) } } };
    },
  },
};

/** 把一个动作的 params 编成完整 OidbBase 字节 */
// SL 里标了 `uinForm: true` 的服务 —— 对应 OidbBase 的 field 7 `reserved = 1`，
// 含义是"body 里的账号字段用 uin 而不是 uid"。
// 我们之前从没带这个字段，导致 create_group_file_folder 恒回 `param error: folder name`
// （服务端把 groupUin 当 uid 解析，folderName 的校验就跟着错位）。
// 这份清单是逐个服务核对 uinForm 得到的：为 1 表示 body 里的账号用 uin 而不是 uid。
const UIN_FORM_WIRES = new Set([
  'OidbSvcTrpcTcp.0x0_100',
  'OidbSvcTrpcTcp.0x11e9_200',
  'OidbSvcTrpcTcp.0x11ea_200',
  'OidbSvcTrpcTcp.0x1255_0',
  'OidbSvcTrpcTcp.0x126d_200',
  'OidbSvcTrpcTcp.0x126e_200',
  'OidbSvcTrpcTcp.0x12a9_100',
  'OidbSvcTrpcTcp.0x12a9_103',
  'OidbSvcTrpcTcp.0x12a9_200',
  'OidbSvcTrpcTcp.0x6d6_0',
  'OidbSvcTrpcTcp.0x6d6_2',
  'OidbSvcTrpcTcp.0x6d6_3',
  'OidbSvcTrpcTcp.0x6d6_4',
  'OidbSvcTrpcTcp.0x6d6_5',
  'OidbSvcTrpcTcp.0x6d7_0',
  'OidbSvcTrpcTcp.0x6d7_1',
  'OidbSvcTrpcTcp.0x6d7_2',
  'OidbSvcTrpcTcp.0x6d8_1',
  'OidbSvcTrpcTcp.0x8b7_5',
  'OidbSvcTrpcTcp.0x902e_1',
  'OidbSvcTrpcTcp.0x902f_1',
  'OidbSvcTrpcTcp.0x904_1',
  'OidbSvcTrpcTcp.0x9060_3',
  'OidbSvcTrpcTcp.0x9067_202',
  'OidbSvcTrpcTcp.0x9164_2',
  'OidbSvcTrpcTcp.0x9427_0',
  'OidbSvcTrpcTcp.0xd69_0',
  'OidbSvcTrpcTcp.0xef0_1',
  'OidbSvcTrpcTcp.0xf00_3',
  'OidbSvcTrpcTcp.0xfe1_2',
  'OidbSvcTrpcTcp.0xfe5_2',
]);

function buildOidbBody(actionName, params) {
  const act = OIDB_ACTIONS[actionName];
  if (!act) throw new Error(`unknown oidb action: ${actionName}`);
  const inner = encodeBySchema(act.body, act.build(params));
  // trpc 命令（群相册那类）没有 OidbBase 外壳，body 就是原始 protobuf —— 靠 `raw: true` 标记跳过包裹。
  if (act.raw === true) return inner;
  const needUinForm = act.uinForm === true || UIN_FORM_WIRES.has(act.wire);
  return wrapOidbBase(act.command, act.subCommand, inner, needUinForm ? 1 : 0);
}

module.exports = { OIDB_ACTIONS, encodeBySchema, wrapOidbBase, buildOidbBody };
