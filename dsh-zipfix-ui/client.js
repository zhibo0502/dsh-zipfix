/**
 * dsh-zipfix-ui 的浏览器半：左侧边栏入口 + 主面板的「上传 ZIP → 体检 → 修复」页面。
 *
 * 只使用页面模块表提供的 react（无 Harness Client 包依赖），样式全部走主题 token，
 * 网络调用走同源 `/zipfix-api`（Host 半注册），与 agent 工具共用同一套修复逻辑。
 */

window.__ModuleLoader__.load({
  id: 'dsh-zipfix-ui',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 字典命名空间。 */
    const NS = 'zipfix.ui';
    /** 侧边栏入口 id，同时作为 `main` 面板的 key。 */
    const PANEL_ID = 'zipfix';

    const zh = {
      'sidebar.label': 'ZIP 修复',
      'panel.title': 'ZIP 中文文件名修复器',
      'panel.subtitle':
        '上传 ZIP 后自动判定文件名编码与乱码形态，可下载「修复版 ZIP」（转发给别人也不会乱码），或按正确文件名解压到指定目录。源压缩包不会被删除或覆盖。',
      'drop.title': '把 ZIP 拖到这里，或点击选择文件',
      'drop.hint': '只处理 .zip；上传仅用于本次修复，任务在 24 小时后自动清理',
      'drop.select': '选择 ZIP 文件',
      'drop.drop': '松开鼠标即开始体检',
      'drop.file': '当前文件：{name}（{size}）',
      'drop.change': '换一个',
      'phase.uploading': '正在上传…',
      'phase.scanning': '正在体检编码…',
      'phase.fixing': '正在重新压缩并逐条校验…',
      'phase.extracting': '正在解压并逐条校验 CRC32…',
      'status.reversible': '可无损还原：文件名是 GBK/Big5 等编码，但 ZIP 未声明 UTF-8',
      'status.no-fix-needed': '文件名编码已合规，无需修复',
      'status.flag-missing-utf8': '名字本身是 UTF-8，只是缺少 0x0800 标志位（重建 ZIP 即可）',
      'status.mixed': '部分条目可还原；另有条目名含 U+FFFD，压缩包内不可逆',
      'status.unknown': '无法识别编码，建议改用 agent 工具并显式指定 encoding',
      'section.scan': '体检结果',
      'field.encoding': '编码',
      'field.confidence': '置信度',
      'field.entries': '条目',
      'field.entriesValue': '{total} 个（文件 {files} / 目录 {dirs}）',
      'field.stripRoot': '冗余顶层目录',
      'field.stripRootNone': '无',
      'field.nonAscii': '非 ASCII 条目',
      'field.irreversible': '含 U+FFFD 条目',
      'field.size': '文件大小',
      'section.samples': '示例（原名字 → 新名字）',
      'samples.empty': '没有可展示的条目（可能全部是 ASCII 名字）',
      'section.options': '修复选项',
      'option.stripRoot': '剥离与 ZIP 同名的冗余顶层目录',
      'option.stripRootHint': '解压时会少一层多余的文件夹；修复版 ZIP 只影响下载包内结构',
      'option.encoding': '文件名编码',
      'option.encodingAuto': '自动嗅探（推荐）',
      'action.fix': '生成修复版 ZIP',
      'action.forceFix': '仍要生成修复版 ZIP',
      'action.extract': '解压到目录…',
      'action.download': '下载修复版 ZIP',
      'action.report': '查看审计报告',
      'action.csv': '下载明细 CSV',
      'action.reset': '换一个 ZIP',
      'busy.hint': '处理期间请保持本页面打开；大文件可能需要数十秒。',
      'result.fixed': '修复版 ZIP 已生成',
      'result.fixedDetail': '{entries} 个条目；UTF-8 标志{flag}；{check}',
      'result.flagAll': '已全部置位',
      'result.flagMissing': '有缺失',
      'result.checkFull': '逐条 CRC32 校验通过',
      'result.checkStructural': '结构校验通过',
      'result.forced': '该 ZIP 编码已合规，已按「强制处理」执行。',
      'result.extract': '已按正确文件名解压',
      'result.extractDetail': '{files} 个文件 / {dirs} 个目录，失败 {failures} 个；输出目录：{dir}',
      'result.irreversible': '包内另有 {count} 个条目名含 U+FFFD（字节已销毁），未擅自改名；如有源包请用 agent 工具 zipfix_match_source。',
      'result.willDownload': '浏览器会直接保存到下载目录。',
      'error.title': '出错了',
      'error.notZip': '请选择 .zip 压缩包',
      'error.noHost': 'Host API 不可用：请重启 DeepSeek Harness 让新插件生效，或改用 agent 工具 zipfix_*。',
      'error.retry': '重试',
      'hint.title': '提示',
    };

    const en = {
      'sidebar.label': 'ZIP Fixer',
      'panel.title': 'ZIP Chinese Filename Fixer',
      'panel.subtitle':
        'Upload a ZIP to detect the entry-name encoding and mojibake form. Download a repaired ZIP whose filenames are valid UTF-8 with bit 11 set, or extract it with correct filenames into a folder. The uploaded archive is never deleted or overwritten.',
      'drop.title': 'Drop a ZIP here, or click to choose a file',
      'drop.hint': 'Only .zip files; uploads are temporary and cleaned up after 24 hours',
      'drop.select': 'Choose ZIP file',
      'drop.drop': 'Release to start the inspection',
      'drop.file': 'Selected: {name} ({size})',
      'drop.change': 'Change',
      'phase.uploading': 'Uploading…',
      'phase.scanning': 'Inspecting encoding…',
      'phase.fixing': 'Recompressing and verifying every entry…',
      'phase.extracting': 'Extracting and verifying CRC32…',
      'status.reversible': 'Reversible: names are GBK/Big5 but the ZIP does not declare UTF-8',
      'status.no-fix-needed': 'Filenames are already valid; no fix needed',
      'status.flag-missing-utf8': 'Names are UTF-8 but bit 11 is missing; rebuilding the ZIP suffices',
      'status.mixed': 'Some entries are reversible; others contain U+FFFD and are irreversible inside the archive',
      'status.unknown': 'Encoding not recognized; use the agent tool with an explicit encoding',
      'section.scan': 'Inspection result',
      'field.encoding': 'Encoding',
      'field.confidence': 'Confidence',
      'field.entries': 'Entries',
      'field.entriesValue': '{total} ({files} files / {dirs} dirs)',
      'field.stripRoot': 'Redundant root folder',
      'field.stripRootNone': 'None',
      'field.nonAscii': 'Non-ASCII entries',
      'field.irreversible': 'U+FFFD entries',
      'field.size': 'Size',
      'section.samples': 'Samples (current → fixed)',
      'samples.empty': 'Nothing to show (possibly all-ASCII names)',
      'section.options': 'Options',
      'option.stripRoot': 'Strip the redundant root folder named after the ZIP',
      'option.stripRootHint': 'Removes one extra folder level on extract',
      'option.encoding': 'Entry-name encoding',
      'option.encodingAuto': 'Auto-detect (recommended)',
      'action.fix': 'Create repaired ZIP',
      'action.forceFix': 'Create repaired ZIP anyway',
      'action.extract': 'Extract to folder…',
      'action.download': 'Download repaired ZIP',
      'action.report': 'View audit report',
      'action.csv': 'Download CSV',
      'action.reset': 'Choose another ZIP',
      'busy.hint': 'Keep this page open while processing; large archives may take a while.',
      'result.fixed': 'Repaired ZIP created',
      'result.fixedDetail': '{entries} entries; UTF-8 flag {flag}; {check}',
      'result.flagAll': 'set on every entry',
      'result.flagMissing': 'missing on some entries',
      'result.checkFull': 'per-entry CRC32 verified',
      'result.checkStructural': 'structural check passed',
      'result.forced': 'The archive was already compliant; forced processing was applied.',
      'result.extract': 'Extracted with correct filenames',
      'result.extractDetail': '{files} files / {dirs} dirs, {failures} failures; output: {dir}',
      'result.irreversible': '{count} more entry names contain U+FFFD (bytes destroyed) and were left untouched; use the agent tool zipfix_match_source when the source archive exists.',
      'result.willDownload': 'The browser saves it to your downloads folder.',
      'error.title': 'Something went wrong',
      'error.notZip': 'Please choose a .zip archive',
      'error.noHost': 'Host API unavailable: restart DeepSeek Harness so the new plugin loads, or use the zipfix_* agent tools.',
      'error.retry': 'Retry',
      'hint.title': 'Note',
    };

    /* ------------------------------------------------------------------ *
     * 样式（只用主题 token，跟随明暗主题）
     * ------------------------------------------------------------------ */

    const S = {
      page: {
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '28px 30px 56px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      inner: { maxWidth: '880px', margin: '0 auto' },
      title: { margin: '0 0 6px', fontSize: '20px', fontWeight: 600, lineHeight: 1.3 },
      subtitle: {
        margin: '0 0 20px',
        fontSize: '13px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '12px',
        padding: '18px',
        marginBottom: '16px',
      },
      cardTitle: { margin: '0 0 12px', fontSize: '14px', fontWeight: 600 },
      drop: (over, busy) => ({
        border: `1.5px dashed ${over ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
        borderRadius: '12px',
        padding: '26px 20px',
        textAlign: 'center',
        cursor: busy ? 'progress' : 'pointer',
        background: over ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        transition: 'border-color 0.15s ease, background 0.15s ease',
        outline: 'none',
      }),
      dropTitle: { fontSize: '14px', fontWeight: 500, marginBottom: '6px' },
      dropHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      fileName: { fontSize: '13px', fontWeight: 500, marginTop: '10px', wordBreak: 'break-all' },
      btn: (variant, disabled) => {
        const primary = variant === 'primary';
        return {
          appearance: 'none',
          border: primary ? '1px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l2)',
          background: primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
          // 品牌色在深色主题下本身就是白色，文字必须取「底色」才能形成对比：
          // 深色主题 → 深色字 + 白色按钮；浅色主题 → 白字 + 品牌色按钮
          color: primary ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
          borderRadius: '8px',
          padding: '8px 14px',
          fontSize: '13px',
          fontWeight: primary ? 600 : 500,
          lineHeight: 1.3,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          marginRight: '8px',
          marginTop: '4px',
        };
      },
      link: {
        color: 'var(--dsw-alias-brand-primary)',
        textDecoration: 'none',
        fontSize: '13px',
        fontWeight: 500,
        marginRight: '14px',
      },
      row: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '6px 0',
        fontSize: '13px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      rowLabel: { color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto' },
      rowValue: { textAlign: 'right', wordBreak: 'break-all', minWidth: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px' },
      sampleRow: {
        display: 'flex',
        gap: '10px',
        alignItems: 'baseline',
        padding: '5px 0',
        fontSize: '12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      sampleOld: {
        flex: '1 1 0',
        minWidth: 0,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      },
      sampleArrow: { color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto' },
      sampleNew: { flex: '1 1 0', minWidth: 0, wordBreak: 'break-all' },
      errorCard: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '12px',
        padding: '14px 16px',
        marginBottom: '16px',
        fontSize: '13px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-primary)',
      },
      warnCard: {
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '12px',
        padding: '12px 16px',
        marginBottom: '16px',
        fontSize: '13px',
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
      },
      successCard: {
        border: '1px solid var(--dsw-alias-state-success-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '12px',
        padding: '16px',
        marginBottom: '16px',
        fontSize: '13px',
        lineHeight: 1.7,
      },
      formRow: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', fontSize: '13px' },
      checkbox: { accentColor: 'var(--dsw-alias-brand-primary)', width: '15px', height: '15px', margin: 0 },
      select: {
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '7px',
        padding: '5px 8px',
        fontSize: '13px',
      },
      statusLine: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '14px', fontWeight: 500 },
      dot: (color) => ({ width: '9px', height: '9px', borderRadius: '50%', background: color, flex: '0 0 auto' }),
      footerHint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '4px' },
    };

    const ENCODINGS = ['auto', 'utf-8', 'gbk', 'gb18030', 'big5'];

    function statusColor(status) {
      switch (status) {
        case 'reversible':
        case 'flag-missing-utf8':
          return 'var(--dsw-alias-state-warn-primary)';
        case 'no-fix-needed':
          return 'var(--dsw-alias-state-success-primary)';
        case 'mixed':
        case 'unknown':
          return 'var(--dsw-alias-state-error-primary)';
        default:
          return 'var(--dsw-alias-state-idle-primary)';
      }
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
      if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
      return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
    }

    function truncate(value, max) {
      const text = String(value ?? '');
      if (text.length <= max) return text;
      return `${text.slice(0, Math.max(0, max - 1))}…`;
    }

    function label(t, key, vars) {
      const raw = t(key);
      const text = typeof raw === 'string' ? raw : key;
      if (vars === undefined) return text;
      return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined || vars[name] === null ? match : String(vars[name])));
    }

    /* ------------------------------------------------------------------ *
     * 侧边栏图标
     * ------------------------------------------------------------------ */

    function ZipfixIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 20;
      const active = props.active === true;
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M6 3.5h7.5L18 8v12.5H6z',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M13.5 3.5V8H18', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
        h('path', {
          d: 'M9 13.2l1.9 1.9 3.9-3.9',
          stroke: active ? 'currentColor' : 'var(--dsw-alias-brand-primary)',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /* ------------------------------------------------------------------ *
     * 主面板页面
     * ------------------------------------------------------------------ */

    function ZipfixPage(props) {
      const tr = props.tr;
      const api = props.api;
      const [phase, setPhase] = React.useState('idle');
      const [error, setError] = React.useState(null);
      const [file, setFile] = React.useState(null);
      const [task, setTask] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [extract, setExtract] = React.useState(null);
      const [dragOver, setDragOver] = React.useState(false);
      const [stripRoot, setStripRoot] = React.useState(true);
      const [encoding, setEncoding] = React.useState('auto');
      const [hostReady, setHostReady] = React.useState(true);
      const inputRef = React.useRef(null);

      const busy = phase === 'uploading' || phase === 'scanning' || phase === 'fixing' || phase === 'extracting';

      React.useEffect(() => {
        let alive = true;
        api
          .ensureToken()
          .then(() => {
            if (alive) setHostReady(true);
          })
          .catch(() => {
            if (alive) setHostReady(false);
          });
        return () => {
          alive = false;
        };
      }, [api]);

      const chooseFile = async (selected) => {
        if (!selected) return;
        setError(null);
        setResult(null);
        setExtract(null);
        if (!/\.zip$/i.test(selected.name)) {
          setError(label(tr, 'error.notZip'));
          return;
        }
        setFile(selected);
        setPhase('uploading');
        try {
          await api.ensureToken();
          const response = await api.upload(selected, encoding === 'auto' ? undefined : encoding);
          setTask(response);
          const hasRoot = typeof response.scan.stripRoot === 'string' && response.scan.stripRoot.length > 0;
          setStripRoot(hasRoot);
          setPhase('ready');
        } catch (uploadError) {
          setError(String(uploadError?.message ?? uploadError));
          setPhase('error');
        }
      };

      const runFix = async () => {
        if (task === undefined || task === null) return;
        setError(null);
        setResult(null);
        setPhase('fixing');
        try {
          const force = task.scan.status === 'no-fix-needed';
          const response = await api.fix(task.taskId, {
            stripRoot,
            force,
            encoding: encoding === 'auto' ? undefined : encoding,
          });
          setResult(response);
          setPhase('ready');
        } catch (fixError) {
          setError(String(fixError?.message ?? fixError));
          setPhase('ready');
        }
      };

      const runExtract = async () => {
        if (task === undefined || task === null) return;
        let outputDir = null;
        try {
          outputDir = await api.pickDirectory();
        } catch (pickError) {
          setError(String(pickError?.message ?? pickError));
          return;
        }
        if (outputDir === null || outputDir === undefined || outputDir === '') return;
        setError(null);
        setExtract(null);
        setPhase('extracting');
        try {
          const response = await api.extract(task.taskId, outputDir, {
            stripRoot,
            force: task.scan.status === 'no-fix-needed',
            encoding: encoding === 'auto' ? undefined : encoding,
          });
          setExtract(response.extract);
          setPhase('ready');
        } catch (extractError) {
          setError(String(extractError?.message ?? extractError));
          setPhase('ready');
        }
      };

      const reset = () => {
        setFile(null);
        setTask(null);
        setResult(null);
        setExtract(null);
        setError(null);
        setPhase('idle');
        setEncoding('auto');
      };

      const scan = task?.scan ?? null;
      const statusKey = scan ? `status.${scan.status}` : null;
      const statusLabel = statusKey ? label(tr, statusKey) : '';

      const cards = [];

      // 上传卡片
      cards.push(
        h(
          'div',
          { style: S.card, key: 'drop' },
          h(
            'div',
            {
              role: 'button',
              tabIndex: 0,
              'aria-label': label(tr, 'drop.select'),
              onClick: () => {
                if (!busy && inputRef.current) inputRef.current.click();
              },
              onKeyDown: (event) => {
                if (!busy && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  if (inputRef.current) inputRef.current.click();
                }
              },
              onDragOver: (event) => {
                event.preventDefault();
                if (!busy) setDragOver(true);
              },
              onDragLeave: () => setDragOver(false),
              onDrop: (event) => {
                event.preventDefault();
                setDragOver(false);
                if (busy) return;
                const dropped = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
                if (dropped) void chooseFile(dropped);
              },
              style: S.drop(dragOver, busy),
            },
            h('input', {
              ref: inputRef,
              type: 'file',
              accept: '.zip,application/zip,application/x-zip-compressed',
              style: { display: 'none' },
              onChange: (event) => {
                const selected = event.target.files ? event.target.files[0] : null;
                event.target.value = '';
                if (selected) void chooseFile(selected);
              },
            }),
            file === null
              ? h('div', null,
                  h('div', { style: S.dropTitle }, dragOver ? label(tr, 'drop.drop') : label(tr, 'drop.title')),
                  h('div', { style: S.dropHint }, label(tr, 'drop.hint')),
                )
              : h('div', null,
                  h('div', { style: S.dropTitle }, label(tr, 'drop.file', { name: file.name, size: formatBytes(file.size) })),
                  h('div', { style: S.dropHint }, busy ? label(tr, 'busy.hint') : label(tr, 'drop.hint')),
                ),
          ),
          busy
            ? h('div', { style: { ...S.footerHint, marginTop: '10px' } }, label(tr, `phase.${phase}`))
            : null,
        ),
      );

      // 体检卡片
      if (scan !== null) {
        const rows = [];
        rows.push(
          h('div', { style: S.statusLine, key: 'status' },
            h('span', { style: S.dot(statusColor(scan.status)) }),
            h('span', null, statusLabel),
          ),
        );
        rows.push(
          h('div', { style: S.row, key: 'enc' },
            h('span', { style: S.rowLabel }, label(tr, 'field.encoding')),
            h('span', { style: S.rowValue }, `${scan.encoding ?? '—'}（${scan.method ?? '—'}，${scan.confidence ?? '—'}）`),
          ),
        );
        if (scan.entries) {
          rows.push(
            h('div', { style: S.row, key: 'entries' },
              h('span', { style: S.rowLabel }, label(tr, 'field.entries')),
              h('span', { style: S.rowValue }, label(tr, 'field.entriesValue', {
                total: scan.entries.total,
                files: scan.entries.files,
                dirs: scan.entries.directories,
              })),
            ),
          );
          rows.push(
            h('div', { style: S.row, key: 'nonascii' },
              h('span', { style: S.rowLabel }, label(tr, 'field.nonAscii')),
              h('span', { style: S.rowValue }, String(scan.entries.nonAscii)),
            ),
          );
        }
        if (scan.stripRoot) {
          rows.push(
            h('div', { style: S.row, key: 'root' },
              h('span', { style: S.rowLabel }, label(tr, 'field.stripRoot')),
              h('span', { style: { ...S.rowValue, ...S.mono } }, scan.stripRoot),
            ),
          );
        }
        if (scan.irreversible && scan.irreversible.length > 0) {
          rows.push(
            h('div', { style: S.row, key: 'irr' },
              h('span', { style: S.rowLabel }, label(tr, 'field.irreversible')),
              h('span', { style: { ...S.rowValue, color: 'var(--dsw-alias-state-error-primary)' } }, String(scan.irreversible.length)),
            ),
          );
        }
        rows.push(
          h('div', { style: S.row, key: 'size' },
            h('span', { style: S.rowLabel }, label(tr, 'field.size')),
            h('span', { style: S.rowValue }, formatBytes(scan.zipSize)),
          ),
        );

        const sampleRows = (scan.samples ?? []).slice(0, 6).map((sample, index) =>
          h('div', { style: S.sampleRow, key: `s${index}` },
            h('span', { style: S.sampleOld, title: sample.original }, truncate(sample.original, 46)),
            h('span', { style: S.sampleArrow }, '→'),
            h('span', { style: { ...S.sampleNew, ...S.mono }, title: sample.fixed }, truncate(sample.fixed, 52)),
          ),
        );

        cards.push(
          h('div', { style: S.card, key: 'scan' },
            h('div', { style: S.cardTitle }, label(tr, 'section.scan')),
            rows,
            h('div', { style: { ...S.cardTitle, marginTop: '14px' } }, label(tr, 'section.samples')),
            sampleRows.length > 0 ? sampleRows : h('div', { style: S.dropHint }, label(tr, 'samples.empty')),
          ),
        );

        // 选项 + 操作卡片
        const noFix = scan.status === 'no-fix-needed';
        cards.push(
          h('div', { style: S.card, key: 'options' },
            h('div', { style: S.cardTitle }, label(tr, 'section.options')),
            h('label', { style: S.formRow },
              h('input', {
                type: 'checkbox',
                checked: stripRoot,
                onChange: (event) => setStripRoot(event.target.checked),
                style: S.checkbox,
                disabled: busy,
              }),
              h('span', null, label(tr, 'option.stripRoot')),
              h('span', { style: { ...S.dropHint, marginLeft: '4px' } }, label(tr, 'option.stripRootHint')),
            ),
            h('label', { style: S.formRow },
              h('span', null, label(tr, 'option.encoding')),
              h('select', {
                value: encoding,
                onChange: (event) => setEncoding(event.target.value),
                style: S.select,
                disabled: busy,
              }, ENCODINGS.map((value) =>
                h('option', { key: value, value }, value === 'auto' ? label(tr, 'option.encodingAuto') : value),
              )),
            ),
            h('div', { style: { marginTop: '6px' } },
              h('button', {
                type: 'button',
                onClick: () => void runFix(),
                disabled: busy,
                style: S.btn('primary', busy),
              }, label(tr, noFix ? 'action.forceFix' : 'action.fix')),
              h('button', {
                type: 'button',
                onClick: () => void runExtract(),
                disabled: busy,
                style: S.btn('secondary', busy),
              }, label(tr, 'action.extract')),
              h('button', {
                type: 'button',
                onClick: reset,
                disabled: busy,
                style: S.btn('secondary', busy),
              }, label(tr, 'action.reset')),
            ),
            busy ? h('div', { style: S.footerHint }, label(tr, `phase.${phase}`)) : null,
          ),
        );
      }

      // 修复结果卡片
      if (result !== null && result.result) {
        const payload = result.result;
        const fixed = payload.fixedZip;
        const lines = [];
        lines.push(
          h('div', { style: S.cardTitle, key: 't' }, label(tr, 'result.fixed')),
        );
        if (fixed) {
          lines.push(
            h('div', { key: 'detail' }, label(tr, 'result.fixedDetail', {
              entries: fixed.entries,
              flag: fixed.allUtf8Flag ? label(tr, 'result.flagAll') : label(tr, 'result.flagMissing'),
              check: fixed.fullChecked ? label(tr, 'result.checkFull') : label(tr, 'result.checkStructural'),
            })),
          );
        }
        if (payload.forced) lines.push(h('div', { key: 'forced', style: { color: 'var(--dsw-alias-label-secondary)' } }, label(tr, 'result.forced')));
        if (result.downloadUrl) {
          lines.push(
            h('div', { key: 'dl', style: { marginTop: '10px' } },
              h('a', { href: result.downloadUrl, style: S.link, download: true }, label(tr, 'action.download')),
              h('a', { href: result.downloadUrl, style: S.link, target: '_blank', rel: 'noreferrer' }, '↗'),
            ),
          );
          lines.push(h('div', { key: 'dlhint', style: S.footerHint }, label(tr, 'result.willDownload')));
        }
        if (result.reportUrl) {
          lines.push(
            h('div', { key: 'rep', style: { marginTop: '8px' } },
              h('a', { href: result.reportUrl, style: S.link, target: '_blank', rel: 'noreferrer' }, label(tr, 'action.report')),
              result.csvUrl ? h('a', { href: result.csvUrl, style: S.link, target: '_blank', rel: 'noreferrer' }, label(tr, 'action.csv')) : null,
            ),
          );
        }
        if (payload.irreversible > 0) {
          lines.push(
            h('div', { key: 'irr', style: { marginTop: '8px', color: 'var(--dsw-alias-state-warn-primary)' } },
              label(tr, 'result.irreversible', { count: payload.irreversible }),
            ),
          );
        }
        cards.push(h('div', { style: S.successCard, key: 'result' }, lines));
      }

      // 解压结果卡片
      if (extract !== null) {
        cards.push(
          h('div', { style: S.successCard, key: 'extract' },
            h('div', { style: S.cardTitle }, label(tr, 'result.extract')),
            h('div', null, label(tr, 'result.extractDetail', {
              files: extract.files,
              dirs: extract.directories,
              failures: extract.failures,
              dir: extract.outputDir,
            })),
            extract.reportMarkdown
              ? h('div', { style: { ...S.footerHint, wordBreak: 'break-all' } }, `报告：${extract.reportMarkdown}`)
              : null,
          ),
        );
      }

      // 错误卡片
      const errorCards = [];
      if (error !== null) {
        errorCards.push(
          h('div', { style: S.errorCard, key: 'error' },
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, label(tr, 'error.title')),
            h('div', { style: { wordBreak: 'break-word' } }, error)),
        );
      }
      if (!hostReady) {
        errorCards.push(
          h('div', { style: S.warnCard, key: 'host' },
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, label(tr, 'hint.title')),
            h('div', null, label(tr, 'error.noHost'))),
        );
      }

      return h('div', { style: S.page },
        h('div', { style: S.inner },
          h('h1', { style: S.title }, label(tr, 'panel.title')),
          h('p', { style: S.subtitle }, label(tr, 'panel.subtitle')),
          errorCards,
          cards,
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * 插件入口
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        // 未声明进 LocaleNamespaceMap 的动态命名空间使用单语言注册形式（官方支持的 untyped form）
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'zipfix-ui: zh dictionary');
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'zipfix-ui: en dictionary');
        const t = ctx.locale.bind(NS);
        const tr = (key, vars) => label(t, key, vars);

        /** 当前页面的 API token（首次访问 /token 获取）。 */
        let token = null;
        let tokenPromise = null;

        const loadToken = () => {
          if (token !== null) return Promise.resolve(token);
          if (tokenPromise === null) {
            tokenPromise = fetch('/zipfix-api/token', { headers: { accept: 'application/json' } })
              .then((response) => response.json())
              .then((payload) => {
                if (!payload || payload.ok !== true || typeof payload.token !== 'string') {
                  throw new Error('Host API 未返回有效令牌');
                }
                token = payload.token;
                return token;
              })
              .catch((error) => {
                tokenPromise = null;
                throw error;
              });
          }
          return tokenPromise;
        };

        const withToken = async (headers) => {
          await loadToken();
          return { ...headers, 'x-zipfix-token': token };
        };

        const requestJson = async (path, options) => {
          const headers = await withToken(options && options.headers ? options.headers : {});
          const response = await fetch(path, { ...(options || {}), headers });
          const text = await response.text();
          let payload = null;
          try {
            payload = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            throw new Error(`服务响应异常（HTTP ${response.status}）`);
          }
          if (!response.ok || (payload && payload.ok === false)) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`);
          }
          return payload;
        };

        const api = {
          ensureToken: () => loadToken(),
          upload(file, encoding) {
            const query = new URLSearchParams({ name: file.name });
            if (typeof encoding === 'string' && encoding.length > 0) query.set('encoding', encoding);
            return requestJson(`/zipfix-api/upload?${query.toString()}`, {
              method: 'POST',
              headers: { 'content-type': 'application/zip' },
              body: file,
            });
          },
          fix(taskId, options) {
            return requestJson('/zipfix-api/fix', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ taskId, ...(options || {}) }),
            });
          },
          extract(taskId, outputDir, options) {
            return requestJson('/zipfix-api/extract', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ taskId, outputDir, ...(options || {}) }),
            });
          },
          pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
        };

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({ tr, api }),
            },
            ZipfixPage,
          ),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              locale: NS,
              label: () => tr('sidebar.label'),
            },
            ZipfixIcon,
          ),
        );
      },
    };
  },
});
