/**
 * Đồng bộ Gantt (Google Sheet) → Supabase (bảng public.gantt_cong_tac)
 * ------------------------------------------------------------------------
 * Người dùng nhập công tác vào Sheet rồi bấm menu "PMIS ▸ Đồng bộ Gantt sang Supabase".
 * Script đọc sheet, kiểm tra hợp lệ, rồi UPSERT theo khóa chính `ma_cong_tac`.
 *
 * CÀI ĐẶT (làm 1 lần):
 *   1) Mở Google Sheet chứa Gantt → menu Tiện ích mở rộng ▸ Apps Script, dán tệp này.
 *   2) Trong Apps Script: biểu tượng ⚙ (Project Settings) ▸ Script properties, thêm:
 *        SUPABASE_URL          = https://ogsblohdodobbfhrvpes.supabase.co
 *        SUPABASE_SERVICE_KEY  = <service_role key của project PMIS>   (Supabase ▸ Settings ▸ API)
 *        GANTT_SHEET_NAME      = Gantt            (tên tab chứa dữ liệu; bỏ trống = "Gantt")
 *   3) Tải lại Google Sheet → sẽ thấy menu "PMIS".
 *
 * BẢO MẬT: service_role key BỎ QUA RLS — chỉ để trong Script properties (KHÔNG viết thẳng vào mã,
 * KHÔNG chia sẻ Sheet cho người ngoài ban). Chỉ cấp quyền sửa Sheet cho cán bộ được phép.
 *
 * GHI CHÚ:
 *   - Chỉ ghi các cột LỊCH: ma_cong_tac, ma_da, ten_cong_tac, ngay_bd, ngay_kt, gia_tri,
 *     nguoi_phu_trach, ghi_chu. KHÔNG đụng hoan_thanh / hoan_thanh_* (do app quản lý).
 *   - `ma_da` phải tồn tại trong bảng du_an (khóa ngoại) — hàng sai mã sẽ bị Supabase từ chối.
 *   - `ma_cong_tac` dạng 8179900-001 (tiền tố là mã dự án). Trùng mã = cập nhật, mới = thêm.
 */

// ── Ánh xạ cột: 'cột_supabase': [các tiêu đề có thể gặp trong Sheet, chữ thường, không dấu] ──
// Chỉnh danh sách bên phải cho khớp tiêu đề thật trong Sheet của bạn.
var COLUMN_MAP = {
  ma_cong_tac:     ['ma_cong_tac', 'ma cong tac', 'mã công tác', 'macongtac', 'ma ct'],
  ma_da:           ['ma_da', 'ma da', 'mã da', 'mã dự án', 'ma du an', 'mada'],
  ten_cong_tac:    ['ten_cong_tac', 'ten cong tac', 'tên công tác', 'ten cong viec', 'tên công việc'],
  ngay_bd:         ['ngay_bd', 'ngay bd', 'ngày bắt đầu', 'ngay bat dau', 'bắt đầu', 'start'],
  ngay_kt:         ['ngay_kt', 'ngay kt', 'ngày kết thúc', 'ngay ket thuc', 'kết thúc', 'end'],
  gia_tri:         ['gia_tri', 'gia tri', 'giá trị', 'giá trị công tác', 'gia tri cong tac', 'gia tri (d)', 'giá trị (đ)', 'value'],
  nguoi_phu_trach: ['nguoi_phu_trach', 'nguoi phu trach', 'người phụ trách', 'người phụ trách kỹ thuật', 'nguoi phu trach ky thuat', 'phu trach', 'phụ trách'],
  ghi_chu:         ['ghi_chu', 'ghi chu', 'ghi chú', 'note', 'ghichu'],
};
// Cột "Trạng thái" → hoan_thanh (boolean). Chỉ ghi khi SYNC_HOAN_THANH = true.
// Lưu ý: nếu sau này để Giám đốc tick hoàn thành TRONG app là nguồn chuẩn, đặt false để Sheet không ghi đè.
var STATUS_HEADERS = ['trang_thai', 'trạng thái', 'trang thai', 'status', 'tình trạng', 'tinh trang'];
var SYNC_HOAN_THANH = true;
var REQUIRED = ['ma_cong_tac', 'ma_da', 'ten_cong_tac'];
var TABLE = 'gantt_cong_tac';
var BATCH = 500;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PMIS')
    .addItem('Đồng bộ Gantt sang Supabase', 'syncGantt')
    .addItem('Kiểm tra dữ liệu (không gửi)', 'dryRunGantt')
    .addToUi();
}

function _cfg() {
  var p = PropertiesService.getScriptProperties();
  var url = (p.getProperty('SUPABASE_URL') || '').replace(/\/+$/, '');
  var key = p.getProperty('SUPABASE_SERVICE_KEY') || '';
  var sheetName = p.getProperty('GANTT_SHEET_NAME') || 'Gantt';
  if (!url || !key) throw new Error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_KEY trong Script properties.');
  return { url: url, key: key, sheetName: sheetName };
}

function _norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ');
}

function _toDate(v) {
  if (v === '' || v == null) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/.exec(s);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return null; // không đọc được → báo lỗi ở validate
}

function _toInt(v) {
  if (v === '' || v == null) return null;
  var n = Number(String(v).replace(/[.\s,]/g, ''));
  return isFinite(n) ? Math.round(n) : null;
}

/** Đọc sheet → {rows, errors}. Chỉ build các cột lịch. */
function _buildRows() {
  var cfg = _cfg();
  var sh = SpreadsheetApp.getActive().getSheetByName(cfg.sheetName);
  if (!sh) throw new Error('Không tìm thấy tab "' + cfg.sheetName + '".');
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { rows: [], errors: ['Sheet chưa có dữ liệu.'] };

  // Lập chỉ mục tiêu đề → cột Supabase
  var header = data[0].map(_norm);
  var idx = {}; // col_supabase -> chỉ số cột
  Object.keys(COLUMN_MAP).forEach(function (col) {
    for (var j = 0; j < header.length; j++) {
      if (COLUMN_MAP[col].map(_norm).indexOf(header[j]) >= 0) { idx[col] = j; break; }
    }
  });
  var missingCols = REQUIRED.filter(function (c) { return idx[c] == null; });
  if (missingCols.length) return { rows: [], errors: ['Thiếu cột bắt buộc trong Sheet: ' + missingCols.join(', ') + '. Sửa COLUMN_MAP hoặc tiêu đề cột.'] };
  // Cột trạng thái (tùy chọn) → hoan_thanh
  var idxStatus = null;
  if (SYNC_HOAN_THANH) { for (var h = 0; h < header.length; h++) { if (STATUS_HEADERS.map(_norm).indexOf(header[h]) >= 0) { idxStatus = h; break; } } }

  var rows = [], errors = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var ma = String(r[idx.ma_cong_tac] == null ? '' : r[idx.ma_cong_tac]).trim();
    if (!ma) continue; // bỏ dòng trống
    var row = {
      ma_cong_tac: ma,
      ma_da: String(r[idx.ma_da] == null ? '' : r[idx.ma_da]).trim(),
      ten_cong_tac: String(r[idx.ten_cong_tac] == null ? '' : r[idx.ten_cong_tac]).trim(),
    };
    if (idx.ngay_bd != null) row.ngay_bd = _toDate(r[idx.ngay_bd]);
    if (idx.ngay_kt != null) row.ngay_kt = _toDate(r[idx.ngay_kt]);
    if (idx.gia_tri != null) row.gia_tri = _toInt(r[idx.gia_tri]);
    if (idx.nguoi_phu_trach != null) row.nguoi_phu_trach = String(r[idx.nguoi_phu_trach] || '').trim() || null;
    if (idx.ghi_chu != null) row.ghi_chu = String(r[idx.ghi_chu] || '').trim() || null;
    if (idxStatus != null) row.hoan_thanh = /hoan thanh/.test(_norm(r[idxStatus]));

    if (!row.ma_da) errors.push('Dòng ' + (i + 1) + ' (' + ma + '): thiếu mã dự án.');
    if (!row.ten_cong_tac) errors.push('Dòng ' + (i + 1) + ' (' + ma + '): thiếu tên công tác.');
    if (idx.ngay_bd != null && r[idx.ngay_bd] !== '' && row.ngay_bd == null) errors.push('Dòng ' + (i + 1) + ' (' + ma + '): ngày bắt đầu không hợp lệ.');
    if (idx.ngay_kt != null && r[idx.ngay_kt] !== '' && row.ngay_kt == null) errors.push('Dòng ' + (i + 1) + ' (' + ma + '): ngày kết thúc không hợp lệ.');
    if (row.ngay_bd && row.ngay_kt && row.ngay_kt < row.ngay_bd) errors.push('Dòng ' + (i + 1) + ' (' + ma + '): ngày kết thúc trước ngày bắt đầu.');
    rows.push(row);
  }
  return { rows: rows, errors: errors };
}

function dryRunGantt() {
  var built = _buildRows();
  var ui = SpreadsheetApp.getUi();
  var msg = 'Số công tác đọc được: ' + built.rows.length + '\n';
  msg += built.errors.length ? ('Lỗi (' + built.errors.length + '):\n- ' + built.errors.slice(0, 30).join('\n- ')) : 'Không có lỗi. Sẵn sàng đồng bộ.';
  ui.alert('Kiểm tra dữ liệu Gantt', msg, ui.ButtonSet.OK);
}

function syncGantt() {
  var cfg = _cfg();
  var built = _buildRows();
  var ui = SpreadsheetApp.getUi();
  if (built.errors.length) {
    var r = ui.alert('Có ' + built.errors.length + ' dòng lỗi',
      built.errors.slice(0, 20).join('\n') + '\n\nVẫn đồng bộ các dòng hợp lệ còn lại?', ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;
  }
  if (!built.rows.length) { ui.alert('Không có công tác nào để đồng bộ.'); return; }

  var endpoint = cfg.url + '/rest/v1/' + TABLE + '?on_conflict=ma_cong_tac';
  var headers = {
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  var sent = 0, fail = 0, failMsg = '';
  for (var i = 0; i < built.rows.length; i += BATCH) {
    var chunk = built.rows.slice(i, i + BATCH);
    var res = UrlFetchApp.fetch(endpoint, {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify(chunk), muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) { sent += chunk.length; }
    else { fail += chunk.length; failMsg = 'HTTP ' + code + ': ' + res.getContentText().slice(0, 300); break; }
  }
  if (fail) {
    ui.alert('Đồng bộ dừng vì lỗi', 'Đã gửi ' + sent + ' công tác. Lỗi ở lô kế tiếp:\n' + failMsg, ui.ButtonSet.OK);
  } else {
    SpreadsheetApp.getActive().toast('Đã đồng bộ ' + sent + ' công tác sang Supabase.', 'PMIS', 6);
  }
}
