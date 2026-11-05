#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 dsh-zipfix 的测试夹具（独立于插件的实现，全部用 Python 编码器手工写 ZIP）。

用法：
    python make_fixtures.py [输出目录]

默认输出到脚本同目录的 fixtures/。

为什么不用 Python zipfile 直接写：
    zipfile 对非 ASCII 名字总会置位 UTF-8 标志，无法复现「GBK 字节 + 未置位」的缺陷包。
    因此这里按 ZIP 规范手工拼装本地文件头 + 中央目录，精确控制 flag_bits。
"""

import json
import os
import struct
import sys
import time
import zlib

DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')


def dos_datetime():
    now = time.localtime()
    mod_time = (now.tm_hour << 11) | (now.tm_min << 5) | (now.tm_sec // 2)
    mod_date = ((now.tm_year - 1980) << 9) | (now.tm_mon << 5) | now.tm_mday
    return mod_time, mod_date


def write_zip(path, entries, flag=0x0000, method=8, comment=b''):
    """entries: [(name_bytes, data_bytes)]；名字以 b'/' 结尾表示目录。"""
    mod_time, mod_date = dos_datetime()
    local_parts = []
    central_parts = []
    offset = 0
    for name, data in entries:
        if isinstance(name, str):
            name = name.encode('utf-8')
        crc = zlib.crc32(data) & 0xFFFFFFFF
        if method == 8:
            compressor = zlib.compressobj(6, zlib.DEFLATED, -15)
            compressed = compressor.compress(data) + compressor.flush()
        else:
            compressed = data
        local = struct.pack(
            '<IHHHHHIIIHH', 0x04034B50, 20, flag, method, mod_time, mod_date,
            crc, len(compressed), len(data), len(name), 0,
        )
        local_parts.append(local + name + compressed)
        central = struct.pack(
            '<IHHHHHHIIIHHHHHII', 0x02014B50, 0, 20, flag, method, mod_time, mod_date,
            crc, len(compressed), len(data), len(name), 0, 0, 0, 0, 0, offset,
        )
        central_parts.append(central + name)
        offset += len(local) + len(name) + len(compressed)
    cd = b''.join(central_parts)
    eocd = struct.pack(
        '<IHHHHIIH', 0x06054B50, 0, 0, len(entries), len(entries),
        len(cd), offset, len(comment),
    ) + comment
    with open(path, 'wb') as handle:
        handle.write(b''.join(local_parts) + cd + eocd)


def write_zip_utf8(path, entries):
    """UTF-8 名字 + 置位 0x0800 的合规 ZIP。"""
    write_zip(path, [(name.encode('utf-8'), data) for name, data in entries], flag=0x0800)


def reset_dir(target):
    if os.path.isdir(target):
        import shutil
        shutil.rmtree(target)
    os.makedirs(target, exist_ok=True)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    os.makedirs(out, exist_ok=True)
    manifest = {'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'fixtures': {}}

    # ---------------------------------------------------------------- 案例 1
    # GBK 文件名 + flag=0x0000，且所有条目包在与 ZIP 同名的顶层目录里（可测剥离）。
    case1_root = '项目资料-二审资料'
    case1_zip = os.path.join(out, f'{case1_root}.zip')
    entries = [(f'{case1_root}/'.encode('gbk'), b'')]
    dirs = [
        '01-立项批复', '02-招标文件', '03-投标文件', '04-合同', '05-施工方案',
        '06-预算书', '07-结算书', '08-图纸', '09-验收资料', '10-变更签证',
        '11-往来函件',
    ]
    for index, dirname in enumerate(dirs, start=1):
        entries.append((f'{case1_root}/{dirname}/'.encode('gbk'), b''))
    files = 0
    for index in range(50):
        dirname = dirs[index % len(dirs)]
        payload = f'案例1 第 {index + 1} 份文件内容\nfake content {index}\n'.encode('utf-8') * (1 + index % 3)
        name = f'{case1_root}/{dirname}/附件{index + 1}：工程资料.docx'
        entries.append((name.encode('gbk'), payload))
        files += 1
    write_zip(case1_zip, entries, flag=0x0000)
    manifest['fixtures']['case1'] = {
        'zip': os.path.basename(case1_zip),
        'entries': len(entries),
        'files': files,
        'expect_encoding': 'gbk',
        'expect_status': 'reversible',
        'strip_root': case1_root,
    }

    # ---------------------------------------------------------------- 案例 3
    # flag=0x0008（只有数据描述符位）+ GBK 名字；再产出「已解压坏」的目录。
    case3_dir = os.path.join(out, 'case3_damaged')
    reset_dir(case3_dir)
    case3_names = [
        '附件1：项目方案. (1).docx',
        '附件2：预算清单.xlsx',
        '审核说明.pdf',
    ]
    case3_sizes = [168865, 15048, 122820]
    case3_entries = []
    case3_pairs = []
    for name, size in zip(case3_names, case3_sizes):
        payload = bytes((i * 37 + len(name)) & 0xFF for i in range(size))
        case3_entries.append((name.encode('gbk'), payload))
        damaged = name.encode('gbk').decode('utf-8', 'replace')
        with open(os.path.join(case3_dir, damaged), 'wb') as handle:
            handle.write(payload)
        case3_pairs.append({
            'name': name,
            'damaged': damaged,
            'size': size,
            'crc32': f'{zlib.crc32(payload) & 0xFFFFFFFF:08X}',
        })
    case3_zip = os.path.join(out, '审核说明.zip')
    write_zip(case3_zip, case3_entries, flag=0x0008)
    manifest['fixtures']['case3'] = {
        'zip': os.path.basename(case3_zip),
        'damaged_dir': 'case3_damaged',
        'expect_encoding': 'gbk',
        'pairs': case3_pairs,
    }

    # ---------------------------------------------------------------- 案例 2
    # 无源包、名字含 U+FFFD 的两个文件。
    case2_dir = os.path.join(out, 'case2_damaged')
    reset_dir(case2_dir)
    case2_names = [
        '附件1：运维费汇总表.xlsx',
        '附件2：运行维护方案.docx',
    ]
    for name in case2_names:
        damaged = name.encode('gbk').decode('utf-8', 'replace')
        with open(os.path.join(case2_dir, damaged), 'wb') as handle:
            handle.write(f'dummy {name}\n'.encode('utf-8'))
    manifest['fixtures']['case2'] = {
        'damaged_dir': 'case2_damaged',
        'names': case2_names,
        'damaged': [name.encode('gbk').decode('utf-8', 'replace') for name in case2_names],
    }

    # ---------------------------------------------------------------- 形态 A 目录
    form_a_dir = os.path.join(out, 'formA_dir')
    reset_dir(form_a_dir)
    form_a_names = [
        '项目资料-二审资料',
        '附件1：预算书.xlsx',
        '附件2：合同扫描件.pdf',
    ]
    form_a_expected = []
    for index, name in enumerate(form_a_names):
        mojibake = name.encode('gbk').decode('cp437')
        form_a_expected.append({'mojibake': mojibake, 'fixed': name})
        if index == 0:
            os.makedirs(os.path.join(form_a_dir, mojibake), exist_ok=True)
            with open(os.path.join(form_a_dir, mojibake, '结算书-终稿.xlsx'.encode('gbk').decode('cp437')), 'wb') as handle:
                handle.write(b'nested file\n')
        else:
            with open(os.path.join(form_a_dir, mojibake), 'wb') as handle:
                handle.write(f'content {index}\n'.encode('utf-8'))
    manifest['fixtures']['formA'] = {'dir': 'formA_dir', 'expect': form_a_expected}

    # ---------------------------------------------------------------- 形态 A2 目录（Latin-1）
    form_a2_dir = os.path.join(out, 'formA2_dir')
    reset_dir(form_a2_dir)
    form_a2_names = ['项目方案.docx', '预算清单.xlsx']
    form_a2_expected = []
    for index, name in enumerate(form_a2_names):
        mojibake = name.encode('gbk').decode('latin-1')
        form_a2_expected.append({'mojibake': mojibake, 'fixed': name})
        with open(os.path.join(form_a2_dir, mojibake), 'wb') as handle:
            handle.write(f'latin1 case {index}\n'.encode('utf-8'))
    manifest['fixtures']['formA2'] = {'dir': 'formA2_dir', 'expect': form_a2_expected}

    # ---------------------------------------------------------------- 合规 ZIP
    utf8_zip = os.path.join(out, 'already_utf8.zip')
    write_zip_utf8(utf8_zip, [
        ('资料/说明.txt', b'hello utf8\n'),
        ('资料/预算表.xlsx', b'binary-ish content'),
        ('目录/', b''),
    ])
    manifest['fixtures']['alreadyUtf8'] = {'zip': os.path.basename(utf8_zip), 'expect_status': 'no-fix-needed'}

    ascii_zip = os.path.join(out, 'ascii.zip')
    write_zip(ascii_zip, [('readme.txt', b'ascii only\n'), ('data/a.csv', b'a,b\n1,2\n')])
    manifest['fixtures']['ascii'] = {'zip': os.path.basename(ascii_zip), 'expect_status': 'no-fix-needed'}

    # ---------------------------------------------------------------- 特殊字符名字
    special_zip = os.path.join(out, 'special_chars.zip')
    special_names = ['资料/附件1：“运维费”汇总表.xlsx', '资料/附件2：《验收报告》（终稿）.pdf']
    write_zip(special_zip, [(name.encode('gbk'), f'payload {index}'.encode()) for index, name in enumerate(special_names)])
    manifest['fixtures']['specialChars'] = {'zip': os.path.basename(special_zip), 'names': special_names}

    # ---------------------------------------------------------------- OOXML 内容反推
    docx_path = os.path.join(out, 'docx_target.docx')
    docx_document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        '<w:p><w:r><w:t>运行维护方案</w:t></w:r></w:p>'
        '<w:p><w:r><w:t>一、项目概况</w:t></w:r></w:p>'
        '</w:body></w:document>'
    )
    docx_app = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
        '<TitlesOfParts><vt:vector xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes" size="2">'
        '<vt:lpstr>运行维护方案</vt:lpstr><vt:lpstr>运行维护</vt:lpstr>'
        '</vt:vector></TitlesOfParts></Properties>'
    )
    write_zip_utf8(docx_path, [
        ('[Content_Types].xml', b'<?xml version="1.0"?><Types/>'),
        ('word/document.xml', docx_document.encode('utf-8')),
        ('docProps/app.xml', docx_app.encode('utf-8')),
    ])

    xlsx_path = os.path.join(out, 'xlsx_target.xlsx')
    xlsx_shared = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<si><t>运维费汇总表</t></si><si><t>1.硬件维护费</t></si><si><t>2.软件运维费用</t></si>'
        '</sst>'
    )
    xlsx_app = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
        '<TitlesOfParts><vt:vector xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes" size="2">'
        '<vt:lpstr>汇总表</vt:lpstr><vt:lpstr>1.硬件维护费</vt:lpstr>'
        '</vt:vector></TitlesOfParts></Properties>'
    )
    write_zip_utf8(xlsx_path, [
        ('[Content_Types].xml', b'<?xml version="1.0"?><Types/>'),
        ('xl/sharedStrings.xml', xlsx_shared.encode('utf-8')),
        ('docProps/app.xml', xlsx_app.encode('utf-8')),
    ])

    # 目标 docx 对应的「已解压坏」副本（供指纹验证 + 内容反推联调）
    verify_dir = os.path.join(out, 'verify_docx')
    reset_dir(verify_dir)
    verify_name = '运行维护方案.docx'
    verify_damaged = verify_name.encode('gbk').decode('utf-8', 'replace')
    with open(docx_path, 'rb') as source:
        docx_bytes = source.read()
    with open(os.path.join(verify_dir, verify_damaged), 'wb') as handle:
        handle.write(docx_bytes)
    manifest['fixtures']['verifyDocx'] = {
        'dir': 'verify_docx',
        'document': 'docx_target.docx',
        'correct_name': verify_name,
        'damaged_name': verify_damaged,
    }
    manifest['fixtures']['xlsxTitles'] = {
        'document': 'xlsx_target.xlsx',
        'expect_titles_contain': ['运维费汇总表', '汇总表', '1.硬件维护费'],
    }

    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    print(f'fixtures written to {out}')
    print(json.dumps(manifest, ensure_ascii=False, indent=2)[:1200])


if __name__ == '__main__':
    main()
