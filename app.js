(() => {
'use strict';

/* ======================= utilidades ======================= */
const cfg = window.APP_CONFIG || {};
const $ = (s, r = document) => r.querySelector(s);
const fmtInt = new Intl.NumberFormat('pt-BR');
const fmtPct = v => (v * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtCnpj = c => {
  const d = String(c ?? '').replace(/\D/g, '');
  return d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : String(c ?? '');
};
const normDN = v => String(v ?? '').trim().replace(/\.0+$/, '');
const normCnpj = v => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d ? d.padStart(14, '0') : '';
};
const fmtDia = iso => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ======================= estado ======================= */
let sb = null;
let rows = [];                              // resumo por loja
const view = { q: '', gcm: '', flag: '', key: 'aprov', dir: -1 };

/* ======================= inicialização ======================= */
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes('SEU-PROJETO') && !cfg.SUPABASE_ANON_KEY.includes('COLE_AQUI');

if (!configured) {
  $('#setup').hidden = false;
} else {
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  sb.auth.onAuthStateChange((_evt, session) => showFor(session));
  sb.auth.getSession().then(({ data }) => showFor(data.session));
}

let loadedFor = null;
function showFor(session) {
  $('#login').hidden = !!session;
  $('#app').hidden = !session;
  if (session) {
    $('#who').textContent = session.user.email;
    if (loadedFor !== session.user.id) { loadedFor = session.user.id; refresh(); }
  } else {
    loadedFor = null;
  }
}

/* ======================= login ======================= */
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-err').textContent = '';
  let error;
  try {
    ({ error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#senha').value }));
  } catch (err) { error = err; }
  if (error) {
    const m = String(error.message || error);
    let txt;
    if (/invalid login credentials/i.test(m)) txt = 'E-mail ou senha incorretos (ou usuário não existe neste projeto Supabase).';
    else if (/email not confirmed/i.test(m)) txt = 'E-mail não confirmado. No Supabase, abra o usuário e confirme-o, ou recrie marcando "Auto Confirm User".';
    else if (/failed to fetch|network/i.test(m)) txt = 'Não consegui falar com o Supabase. Confira a SUPABASE_URL no config.js.';
    else if (/invalid api key|apikey/i.test(m)) txt = 'Chave inválida. Confira a SUPABASE_ANON_KEY no config.js (use a "anon public").';
    else txt = 'Erro: ' + m;
    $('#login-err').textContent = txt;
  }
});
$('#btn-sair').addEventListener('click', () => sb.auth.signOut());

/* ======================= carga de dados ======================= */
async function refresh() {
  try {
    await Promise.all([loadResumo(), loadPeriodo()]);
  } catch (err) {
    $('#rows').innerHTML = `<tr><td colspan="11" class="empty">Não foi possível carregar os dados: ${esc(err.message || err)}</td></tr>`;
  }
}

async function loadResumo() {
  const p_ini = $('#dt-ini').value || null;
  const p_fim = $('#dt-fim').value || null;
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.rpc('resumo_lojas', { p_ini, p_fim }).range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  rows = all.map(r => {
    const aprov = Number(r.aprov), rec = Number(r.rec), total = aprov + rec;
    const pct = total ? aprov / total : 0;
    return {
      dn: r.dn, cnpj: r.cnpj || '', razao_social: r.razao_social || '', gcm: r.gcm || '',
      aprov, rec, total, pct,
      gt5: aprov > 5, gt40: pct > 0.4, full: total > 0 && aprov === total
    };
  });
  fillGcm();
  render();
}

async function loadPeriodo() {
  const { data, error } = await sb.from('importacoes').select('*').eq('tipo', 'propostas')
    .order('criado_em', { ascending: false }).limit(1);
  if (error) throw error;
  const el = $('#periodo');
  if (!data.length) { el.textContent = 'Nenhuma proposta importada'; return; }
  const i = data[0];
  const quando = new Date(i.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  el.textContent = `Propostas de ${fmtDia(i.periodo_ini)} a ${fmtDia(i.periodo_fim)} · importadas em ${quando}`;
}

/* ======================= tabela ======================= */
function fillGcm() {
  const sel = $('#gcm'), atual = sel.value;
  const nomes = [...new Set(rows.map(r => r.gcm).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  sel.innerHTML = '<option value="">Todos</option>' + nomes.map(n => `<option>${esc(n)}</option>`).join('');
  if (nomes.includes(atual)) sel.value = atual;
}

function filtered() {
  const q = view.q.trim().toLowerCase();
  const qd = q.replace(/\D/g, '');
  let out = rows.filter(r => {
    if (view.gcm && r.gcm !== view.gcm) return false;
    if (view.flag === 'gt5' && !r.gt5) return false;
    if (view.flag === 'gt40' && !r.gt40) return false;
    if (view.flag === 'full' && !r.full) return false;
    if (view.flag === 'none' && r.total !== 0) return false;
    if (q) {
      const hit = r.dn.toLowerCase().includes(q) || r.razao_social.toLowerCase().includes(q) ||
        r.gcm.toLowerCase().includes(q) || (qd && r.cnpj.replace(/\D/g, '').includes(qd));
      if (!hit) return false;
    }
    return true;
  });
  const k = view.key, d = view.dir;
  out.sort((a, b) => {
    const x = a[k], y = b[k];
    let c;
    if (typeof x === 'number' || typeof x === 'boolean') c = Number(x) - Number(y);
    else if (k === 'dn' && !isNaN(x) && !isNaN(y)) c = Number(x) - Number(y);
    else c = String(x).localeCompare(String(y), 'pt-BR');
    return (c || a.dn.localeCompare(b.dn, undefined, { numeric: true })) * d;
  });
  return out;
}

function render() {
  const list = filtered();

  const aprov = list.reduce((s, r) => s + r.aprov, 0);
  const rec = list.reduce((s, r) => s + r.rec, 0);
  const taxa = aprov + rec ? aprov / (aprov + rec) : 0;
  $('#stats').innerHTML = [
    [fmtInt.format(list.length), 'lojas'],
    [fmtInt.format(aprov), 'aprovadas'],
    [fmtInt.format(rec), 'recusadas'],
    [fmtPct(taxa), 'taxa de aprovação'],
    [fmtInt.format(list.filter(r => r.gt5).length), 'lojas com mais de 5 aprovadas'],
    [fmtInt.format(list.filter(r => r.gt40).length), 'lojas acima de 40%']
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');

  if (!rows.length) {
    $('#rows').innerHTML = '<tr><td colspan="11" class="empty">Nenhuma loja cadastrada. Use “Enviar lojas” para começar.</td></tr>';
  } else if (!list.length) {
    $('#rows').innerHTML = '<tr><td colspan="11" class="empty">Nenhuma loja com esses filtros.</td></tr>';
  } else {
    $('#rows').innerHTML = list.map(r => `
      <tr>
        <td class="r num">${esc(r.dn)}</td>
        <td class="num">${esc(r.cnpj)}</td>
        <td class="razao" title="${esc(r.razao_social)}">${esc(r.razao_social)}</td>
        <td>${esc(r.gcm)}</td>
        <td class="r num">${r.aprov}</td>
        <td class="c">${r.gt5 ? '<span class="flag">Sim</span>' : ''}</td>
        <td class="r num rec">${r.rec}</td>
        <td><div class="rate"><div class="bar"><i class="${r.gt40 ? 'ok' : ''}" style="width:${(r.pct * 100).toFixed(1)}%"></i></div><span class="num">${fmtPct(r.pct)}</span></div></td>
        <td class="r num">${r.total}</td>
        <td class="c">${r.gt40 ? '<span class="flag">Sim</span>' : ''}</td>
        <td class="c">${r.full ? '<span class="flag warn">Sim</span>' : ''}</td>
      </tr>`).join('');
  }
  $('#count').textContent = `${fmtInt.format(list.length)} de ${fmtInt.format(rows.length)} lojas`;

  document.querySelectorAll('#tbl th').forEach(th => {
    th.querySelector('.arrow')?.remove();
    if (th.dataset.k === view.key) {
      th.setAttribute('aria-sort', view.dir === 1 ? 'ascending' : 'descending');
      th.insertAdjacentHTML('beforeend', `<span class="arrow">${view.dir === 1 ? '▲' : '▼'}</span>`);
    } else th.removeAttribute('aria-sort');
  });
}

$('#tbl thead').addEventListener('click', e => {
  const th = e.target.closest('th'); if (!th) return;
  const k = th.dataset.k;
  if (view.key === k) view.dir *= -1;
  else { view.key = k; view.dir = ['dn', 'cnpj', 'razao_social', 'gcm'].includes(k) ? 1 : -1; }
  render();
});
$('#q').addEventListener('input', e => { view.q = e.target.value; render(); });
$('#gcm').addEventListener('change', e => { view.gcm = e.target.value; render(); });
$('#flag').addEventListener('change', e => { view.flag = e.target.value; render(); });
$('#btn-aplicar').addEventListener('click', () => loadResumo().catch(err => alert('Erro: ' + (err.message || err))));

$('#btn-export').addEventListener('click', () => {
  const list = filtered();
  const cab = ['DN', 'CNPJ', 'RAZAO_SOCIAL', 'GCM', 'APROV', '> 5 AP', 'REC', '%', 'TOTAL', '> 40%', '100%'];
  const cell = v => `"${String(v).replace(/"/g, '""')}"`;
  const linhas = list.map(r => [
    r.dn, r.cnpj, r.razao_social, r.gcm, r.aprov, r.gt5 ? 'S' : '', r.rec,
    (r.pct * 100).toFixed(1).replace('.', ',') + '%', r.total, r.gt40 ? 'S' : '', r.full ? 'S' : ''
  ].map(cell).join(';'));
  const blob = new Blob(['\uFEFF' + [cab.map(cell).join(';'), ...linhas].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aprovadas_por_loja_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ======================= diálogo ======================= */
const dlg = $('#dlg');
function openDialog({ title, body, buttons }) {
  $('#dlg-h').textContent = title;
  $('#dlg-b').innerHTML = body;
  const f = $('#dlg-f');
  f.innerHTML = '';
  (buttons || []).forEach(b => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn' + (b.primary ? ' primary' : '');
    el.textContent = b.label;
    el.addEventListener('click', b.onClick);
    f.appendChild(el);
  });
  if (!dlg.open) dlg.showModal();
}
const closeDialog = () => dlg.open && dlg.close();
dlg.addEventListener('cancel', e => { if (dlg.dataset.busy === '1') e.preventDefault(); });

function showProgress(title, texto) {
  dlg.dataset.busy = '1';
  openDialog({
    title,
    body: `<div class="progress"><i id="pg"></i></div><div class="progress-t" id="pg-t">${esc(texto)}</div>`,
    buttons: []
  });
}
function setProgress(frac, texto) {
  $('#pg').style.width = Math.round(frac * 100) + '%';
  if (texto) $('#pg-t').textContent = texto;
}
function finishDialog(title, html) {
  dlg.dataset.busy = '0';
  openDialog({ title, body: html, buttons: [{ label: 'Fechar', primary: true, onClick: closeDialog }] });
}
function fail(title, err) {
  finishDialog(title, `<p class="msg-err">${esc(err.message || err)}</p>`);
}

async function withRetry(fn, tries = 2) {
  for (let i = 0; ; i++) {
    const r = await fn();
    if (!r.error || i >= tries - 1) return r;
    await sleep(800);
  }
}

/* ======================= upload: LOJAS ======================= */
$('#btn-lojas').addEventListener('click', () => $('#file-lojas').click());
$('#file-lojas').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  showProgress('Enviar lojas', `Lendo ${file.name}…`);
  await sleep(30);
  try {
    const lojas = await readLojas(file);
    dlg.dataset.busy = '0';
    openDialog({
      title: 'Enviar lojas',
      body: `<dl><dt>Arquivo</dt><dd>${esc(file.name)}</dd><dt>Lojas encontradas</dt><dd>${fmtInt.format(lojas.length)}</dd>
             <dt>Colunas usadas</dt><dd>DN, CNPJ, RAZAO_SOCIAL, GCM</dd></dl>
             <label class="chk"><input type="checkbox" id="chk-rm" checked>
             <span>Remover do sistema as lojas que não estão neste arquivo</span></label>`,
      buttons: [
        { label: 'Cancelar', onClick: closeDialog },
        { label: 'Importar lojas', primary: true, onClick: () => importLojas(file, lojas, $('#chk-rm').checked) }
      ]
    });
  } catch (err) { fail('Não foi possível ler o arquivo', err); }
});

async function readLojas(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  for (const nome of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: '' });
    const h = aoa.findIndex(r => {
      const u = r.map(c => String(c).trim().toUpperCase());
      return u.includes('DN') && u.includes('CNPJ') && u.includes('RAZAO_SOCIAL');
    });
    if (h < 0) continue;
    const head = aoa[h].map(c => String(c).trim().toUpperCase());
    const ix = k => head.indexOf(k);
    const map = new Map();
    for (const r of aoa.slice(h + 1)) {
      const dn = normDN(r[ix('DN')]);
      if (!dn) continue;
      map.set(dn, {
        dn,
        cnpj: normCnpj(r[ix('CNPJ')]),
        razao_social: String(r[ix('RAZAO_SOCIAL')] ?? '').trim(),
        gcm: ix('GCM') >= 0 ? String(r[ix('GCM')] ?? '').trim() : ''
      });
    }
    if (map.size) return [...map.values()];
  }
  throw new Error('Não encontrei as colunas DN, CNPJ, RAZAO_SOCIAL (e GCM) no arquivo.');
}

async function importLojas(file, lojas, remover) {
  showProgress('Enviar lojas', 'Gravando lojas…');
  try {
    const size = 500;
    for (let i = 0; i < lojas.length; i += size) {
      const lote = lojas.slice(i, i + size).map(l => ({ ...l, atualizado_em: new Date().toISOString() }));
      const { error } = await withRetry(() => sb.from('lojas').upsert(lote, { onConflict: 'dn' }));
      if (error) throw error;
      setProgress(Math.min(1, (i + size) / lojas.length), `Gravando lojas… ${Math.min(i + size, lojas.length)} de ${lojas.length}`);
    }
    let removidas = 0;
    if (remover) {
      const { data, error } = await sb.from('lojas').select('dn');
      if (error) throw error;
      const manter = new Set(lojas.map(l => l.dn));
      const sobra = data.map(d => d.dn).filter(dn => !manter.has(dn));
      for (let i = 0; i < sobra.length; i += 100) {
        const { error: e2 } = await sb.from('lojas').delete().in('dn', sobra.slice(i, i + 100));
        if (e2) throw e2;
      }
      removidas = sobra.length;
    }
    await logImport({ tipo: 'lojas', arquivo: file.name, linhas: lojas.length });
    await refresh();
    finishDialog('Lojas importadas',
      `<dl><dt>Lojas gravadas</dt><dd>${fmtInt.format(lojas.length)}</dd><dt>Lojas removidas</dt><dd>${fmtInt.format(removidas)}</dd></dl>`);
  } catch (err) { fail('Erro ao importar lojas', err); }
}

/* ======================= upload: PROPOSTAS ======================= */
$('#btn-propostas').addEventListener('click', () => $('#file-propostas').click());
$('#file-propostas').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  showProgress('Enviar propostas', `Lendo ${file.name}… arquivos grandes levam alguns segundos.`);
  await sleep(30);
  try {
    const r = await readPropostas(file);
    dlg.dataset.busy = '0';
    const outros = r.total - r.aprovadas - r.recusadas;
    openDialog({
      title: 'Enviar propostas',
      body: `<dl>
               <dt>Arquivo</dt><dd>${esc(file.name)}</dd>
               <dt>Propostas</dt><dd>${fmtInt.format(r.rows.length)}</dd>
               <dt>Período</dt><dd>${fmtDia(r.ini)} a ${fmtDia(r.fim)}</dd>
               <dt>Aprovadas</dt><dd>${fmtInt.format(r.aprovadas)}</dd>
               <dt>Recusadas</dt><dd>${fmtInt.format(r.recusadas)}</dd>
               <dt>Outros status</dt><dd>${fmtInt.format(outros)} (não entram na taxa)</dd>
             </dl>
             <label class="chk"><input type="checkbox" id="chk-clear" checked>
             <span>Apagar as propostas já importadas antes de gravar estas</span></label>
             ${r.ignoradas ? `<div class="note">${fmtInt.format(r.ignoradas)} linha(s) sem ID_PROPOSTA ou CONCESSIONARIA foram ignoradas.</div>` : ''}`,
      buttons: [
        { label: 'Cancelar', onClick: closeDialog },
        { label: 'Importar propostas', primary: true, onClick: () => importPropostas(file, r, $('#chk-clear').checked) }
      ]
    });
  } catch (err) { fail('Não foi possível ler o arquivo', err); }
});

// "Texto para colunas": o separador (vírgula, ponto e vírgula, tab ou |) é detectado
// automaticamente e cada coluna é lida pelo nome do cabeçalho.
function readPropostas(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: h => h.replace(/^\uFEFF/, '').trim().toUpperCase(),
      complete: res => {
        const obrig = ['ID_PROPOSTA', 'CONCESSIONARIA', 'STATUS', 'DATA_INCLUSAO'];
        const faltam = obrig.filter(c => !(res.meta.fields || []).includes(c));
        if (faltam.length) return reject(new Error('Colunas não encontradas no arquivo: ' + faltam.join(', ')));
        const map = new Map();
        let ignoradas = 0, total = 0, aprovadas = 0, recusadas = 0, ini = null, fim = null;
        for (const r of res.data) {
          const id = String(r.ID_PROPOSTA ?? '').replace(/\D/g, '');
          const dn = normDN(r.CONCESSIONARIA);
          if (!id || !dn) { ignoradas++; continue; }
          const data = parseData(r.DATA_INCLUSAO);
          map.set(id, { id_proposta: Number(id), concessionaria: dn, status: String(r.STATUS ?? '').trim(), data_inclusao: data });
          if (data) { if (!ini || data < ini) ini = data; if (!fim || data > fim) fim = data; }
        }
        for (const p of map.values()) {
          total++;
          const s = p.status.toLowerCase();
          if (s === 'aprovada') aprovadas++; else if (s === 'recusada') recusadas++;
        }
        if (!map.size) return reject(new Error('Nenhuma proposta válida encontrada no arquivo.'));
        resolve({ rows: [...map.values()], ignoradas, total, aprovadas, recusadas, ini, fim });
      },
      error: reject
    });
  });
}

function parseData(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  return null;
}

async function importPropostas(file, r, limpar) {
  showProgress('Enviar propostas', 'Preparando…');
  try {
    if (limpar) {
      setProgress(0, 'Apagando propostas anteriores…');
      const { error } = await sb.rpc('limpar_propostas');
      if (error) throw error;
    }
    const size = 2000, n = r.rows.length;
    for (let i = 0; i < n; i += size) {
      const lote = r.rows.slice(i, i + size);
      const { error } = await withRetry(() => sb.from('propostas').upsert(lote, { onConflict: 'id_proposta' }));
      if (error) throw error;
      const feito = Math.min(i + size, n);
      setProgress(feito / n, `Gravando propostas… ${fmtInt.format(feito)} de ${fmtInt.format(n)}`);
    }
    await logImport({ tipo: 'propostas', arquivo: file.name, linhas: n, periodo_ini: r.ini, periodo_fim: r.fim });
    await refresh();
    finishDialog('Propostas importadas',
      `<dl><dt>Propostas gravadas</dt><dd>${fmtInt.format(n)}</dd><dt>Período</dt><dd>${fmtDia(r.ini)} a ${fmtDia(r.fim)}</dd></dl>`);
  } catch (err) { fail('Erro ao importar propostas', err); }
}

async function logImport(rec) {
  const { data } = await sb.auth.getUser();
  const { error } = await sb.from('importacoes').insert({ ...rec, usuario: data?.user?.email || null });
  if (error) console.warn('Não foi possível registrar a importação:', error.message);
}

})();
