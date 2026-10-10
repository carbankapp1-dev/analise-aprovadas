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
const DIAS_RETENCAO = 15;               // propostas mais antigas que isso são descartadas
function dataCorte() {                  // início do dia, DIAS_RETENCAO dias atrás (hora local)
  const d = new Date();
  d.setDate(d.getDate() - DIAS_RETENCAO);
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T00:00:00`;
}

/* ======================= estado ======================= */
let sb = null;
let rows = [];                              // resumo por loja
let applied = { ini: null, fim: null };     // período já aplicado na consulta
const view = { q: '', gcm: '', coord: '', flag: '', key: 'aprov', dir: -1 };

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
    $('#rows').innerHTML = `<tr><td colspan="12" class="empty">Não foi possível carregar os dados: ${esc(err.message || err)}</td></tr>`;
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
      dn: r.dn, cnpj: r.cnpj || '', razao_social: r.razao_social || '', gcm: r.gcm || '', coordenador: r.coordenador || '',
      poten: r.potencial == null ? null : Number(r.potencial),
      aprov, rec, total, pct,
      gt5: aprov > 5, gt40: pct > 0.4, full: total > 0 && aprov === total
    };
  });
  applied = { ini: p_ini, fim: p_fim };
  fillCoord();
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
const nomesUnicos = lista => [...new Set(lista.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
const opcoes = nomes => '<option value="">Todos</option>' + nomes.map(n => `<option>${esc(n)}</option>`).join('');

function fillCoord() {
  const sel = $('#coord');
  const nomes = nomesUnicos(rows.map(r => r.coordenador));
  $('#lbl-coord').hidden = nomes.length === 0;   // só aparece se o arquivo de lojas trouxe COORDENADOR
  sel.innerHTML = opcoes(nomes);
  if (nomes.includes(view.coord)) sel.value = view.coord; else view.coord = '';
}

// a lista de GCM mostra só os GCMs do coordenador escolhido
function fillGcm() {
  const sel = $('#gcm');
  const base = view.coord ? rows.filter(r => r.coordenador === view.coord) : rows;
  const nomes = nomesUnicos(base.map(r => r.gcm));
  sel.innerHTML = opcoes(nomes);
  if (nomes.includes(view.gcm)) sel.value = view.gcm; else view.gcm = '';
}

function filtered() {
  const q = view.q.trim().toLowerCase();
  const qd = q.replace(/\D/g, '');
  let out = rows.filter(r => {
    if (view.coord && r.coordenador !== view.coord) return false;
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
    if (k === 'poten') c = (x ?? -1) - (y ?? -1);
    else if (typeof x === 'number' || typeof x === 'boolean') c = Number(x) - Number(y);
    else if (k === 'dn' && !isNaN(x) && !isNaN(y)) c = Number(x) - Number(y);
    else c = String(x).localeCompare(String(y), 'pt-BR');
    return (c || a.dn.localeCompare(b.dn, undefined, { numeric: true })) * d;
  });
  return out;
}

// destaca (fundo verde, letra branca) os filtros que estão ativos
function markFilters() {
  const on = (sel, ativo) => $(sel).classList.toggle('on', !!ativo);
  on('#q', view.q.trim());
  on('#coord', view.coord);
  on('#gcm', view.gcm);
  on('#flag', view.flag);
  on('#dt-ini', $('#dt-ini').value && $('#dt-ini').value === applied.ini);
  on('#dt-fim', $('#dt-fim').value && $('#dt-fim').value === applied.fim);
}

function render() {
  markFilters();
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
    $('#rows').innerHTML = '<tr><td colspan="12" class="empty">Nenhuma loja cadastrada. Use “Enviar lojas” para começar.</td></tr>';
  } else if (!list.length) {
    $('#rows').innerHTML = '<tr><td colspan="12" class="empty">Nenhuma loja com esses filtros.</td></tr>';
  } else {
    $('#rows').innerHTML = list.map(r => `
      <tr>
        <td class="r num">${esc(r.dn)}</td>
        <td class="num">${esc(r.cnpj)}</td>
        <td class="razao" title="${esc(r.razao_social)}">${esc(r.razao_social)}</td>
        <td title="${esc(r.gcm)}">${esc(r.gcm)}</td>
        <td class="r num">${r.poten == null ? '<span class="muted">–</span>' : fmtInt.format(r.poten)}</td>
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
$('#coord').addEventListener('change', e => { view.coord = e.target.value; fillGcm(); render(); });
$('#gcm').addEventListener('change', e => { view.gcm = e.target.value; render(); });
$('#flag').addEventListener('change', e => { view.flag = e.target.value; render(); });
$('#dt-ini').addEventListener('input', markFilters);
$('#dt-fim').addEventListener('input', markFilters);
$('#btn-aplicar').addEventListener('click', () => loadResumo().catch(err => alert('Erro: ' + (err.message || err))));

$('#btn-export').addEventListener('click', () => {
  const list = filtered();
  const cab = ['DN', 'CNPJ', 'RAZAO_SOCIAL', 'GCM', 'POTEN.', 'APROV', '> 5 AP', 'REC', '%', 'TOTAL', '> 40%', '100%'];
  const cell = v => `"${String(v).replace(/"/g, '""')}"`;
  const linhas = list.map(r => [
    r.dn, r.cnpj, r.razao_social, r.gcm, r.poten ?? '', r.aprov, r.gt5 ? 'S' : '', r.rec,
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
             <dt>Colunas usadas</dt><dd>DN, CNPJ, RAZAO_SOCIAL, GCM${lojas.some(l => 'coordenador' in l) ? ', COORDENADOR' : ''}</dd></dl>
             <label class="chk"><input type="checkbox" id="chk-rm">
             <span>Remover do sistema as lojas que não estão neste arquivo<br><small>Deixe desmarcado ao enviar uma filial por vez, senão as lojas da outra filial seriam apagadas.</small></span></label>`,
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
    const iCoord = head.findIndex(c => c === 'COORDENADOR' || c === 'COORDENADORA');
    const map = new Map();
    for (const r of aoa.slice(h + 1)) {
      const dn = normDN(r[ix('DN')]);
      if (!dn) continue;
      const loja = {
        dn,
        cnpj: normCnpj(r[ix('CNPJ')]),
        razao_social: String(r[ix('RAZAO_SOCIAL')] ?? '').trim(),
        gcm: ix('GCM') >= 0 ? String(r[ix('GCM')] ?? '').trim() : ''
      };
      // COORDENADOR é opcional; sem a coluna, o valor já gravado é mantido
      if (iCoord >= 0) loja.coordenador = String(r[iCoord] ?? '').trim();
      map.set(dn, loja);
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
             <label class="chk"><input type="checkbox" id="chk-clear">
             <span>Apagar as propostas já importadas antes de gravar estas<br><small>Deixe desmarcado ao enviar uma filial por vez. As propostas com mais de ${DIAS_RETENCAO} dias são removidas sozinhas.</small></span></label>
             ${r.antigas ? `<div class="note">${fmtInt.format(r.antigas)} proposta(s) com mais de ${DIAS_RETENCAO} dias não serão importadas.</div>` : ''}
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
        let ignoradas = 0, antigas = 0, total = 0, aprovadas = 0, recusadas = 0, ini = null, fim = null;
        const corte = dataCorte();
        for (const r of res.data) {
          const id = String(r.ID_PROPOSTA ?? '').replace(/\D/g, '');
          const dn = normDN(r.CONCESSIONARIA);
          if (!id || !dn) { ignoradas++; continue; }
          const data = parseData(r.DATA_INCLUSAO);
          if (data && data < corte) { antigas++; continue; }
          map.set(id, { id_proposta: Number(id), concessionaria: dn, status: String(r.STATUS ?? '').trim(), data_inclusao: data });
          if (data) { if (!ini || data < ini) ini = data; if (!fim || data > fim) fim = data; }
        }
        for (const p of map.values()) {
          total++;
          const s = p.status.toLowerCase();
          if (s === 'aprovada') aprovadas++; else if (s === 'recusada') recusadas++;
        }
        if (!map.size) return reject(new Error(`Nenhuma proposta dos últimos ${DIAS_RETENCAO} dias encontrada no arquivo.`));
        resolve({ rows: [...map.values()], ignoradas, antigas, total, aprovadas, recusadas, ini, fim });
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
    setProgress(1, `Removendo propostas com mais de ${DIAS_RETENCAO} dias…`);
    const { data: removidas, error: eRm } = await sb.rpc('limpar_propostas_antigas', { p_dias: DIAS_RETENCAO });
    await logImport({ tipo: 'propostas', arquivo: file.name, linhas: n, periodo_ini: r.ini, periodo_fim: r.fim });
    await refresh();
    const linhaRm = eRm
      ? `<div class="note">Propostas gravadas, mas não consegui apagar as antigas: ${esc(eRm.message)}. Rode o SQL de retenção no Supabase.</div>`
      : `<dt>Antigas removidas</dt><dd>${fmtInt.format(Number(removidas) || 0)} (mais de ${DIAS_RETENCAO} dias)</dd>`;
    finishDialog('Propostas importadas',
      `<dl><dt>Propostas gravadas</dt><dd>${fmtInt.format(n)}</dd><dt>Período</dt><dd>${fmtDia(r.ini)} a ${fmtDia(r.fim)}</dd>${eRm ? '' : linhaRm}</dl>${eRm ? linhaRm : ''}`);
  } catch (err) { fail('Erro ao importar propostas', err); }
}


/* ======================= upload: POTENCIAL ======================= */
$('#btn-potencial').addEventListener('click', () => $('#file-potencial').click());
$('#file-potencial').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  showProgress('Enviar potencial', `Lendo ${file.name}…`);
  await sleep(30);
  try {
    const r = await readPotencial(file);
    const lojasCnpj = new Set(rows.map(l => l.cnpj));
    const casam = r.rows.filter(p => lojasCnpj.has(p.cnpj)).length;
    dlg.dataset.busy = '0';
    openDialog({
      title: 'Enviar potencial',
      body: `<dl><dt>Arquivo</dt><dd>${esc(file.name)}</dd>
             <dt>CNPJs no arquivo</dt><dd>${fmtInt.format(r.rows.length)}</dd>
             <dt>Casam com lojas cadastradas</dt><dd>${fmtInt.format(casam)} de ${fmtInt.format(rows.length)} lojas</dd></dl>
             <label class="chk"><input type="checkbox" id="chk-pot">
             <span>Substituir todos os potenciais já importados<br><small>Deixe desmarcado ao enviar uma filial por vez.</small></span></label>
             ${r.invalidas ? `<div class="note">${fmtInt.format(r.invalidas)} linha(s) com potencial inválido foram ignoradas.</div>` : ''}`,
      buttons: [
        { label: 'Cancelar', onClick: closeDialog },
        { label: 'Importar potencial', primary: true, onClick: () => importPotencial(file, r.rows, $('#chk-pot').checked) }
      ]
    });
  } catch (err) { fail('Não foi possível ler o arquivo', err); }
});

async function readPotencial(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const isPot = x => x === 'POTENCIAL' || x === 'POTEN.' || x === 'POTEN';
  for (const nome of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: '' });
    const h = aoa.findIndex(r => {
      const u = r.map(c => String(c).trim().toUpperCase());
      return u.includes('CNPJ') && u.some(isPot);
    });
    if (h < 0) continue;
    const head = aoa[h].map(c => String(c).trim().toUpperCase());
    const ic = head.indexOf('CNPJ'), ip = head.findIndex(isPot);
    const map = new Map();
    let invalidas = 0;
    for (const r of aoa.slice(h + 1)) {
      const cnpj = normCnpj(r[ic]);
      if (!cnpj) continue;
      const v = Number(String(r[ip]).trim().replace(',', '.'));
      if (!Number.isFinite(v)) { invalidas++; continue; }
      map.set(cnpj, { cnpj, potencial: Math.round(v) });
    }
    if (map.size) return { rows: [...map.values()], invalidas };
  }
  throw new Error('Não encontrei as colunas CNPJ e Potencial no arquivo.');
}

async function importPotencial(file, lista, substituir) {
  showProgress('Enviar potencial', 'Gravando potencial…');
  try {
    if (substituir) {
      const { error } = await sb.from('potencial').delete().neq('cnpj', '');
      if (error) throw error;
    }
    const size = 1000;
    for (let i = 0; i < lista.length; i += size) {
      const { error } = await withRetry(() => sb.from('potencial').upsert(lista.slice(i, i + size), { onConflict: 'cnpj' }));
      if (error) throw error;
      const feito = Math.min(i + size, lista.length);
      setProgress(feito / lista.length, `Gravando potencial… ${fmtInt.format(feito)} de ${fmtInt.format(lista.length)}`);
    }
    await logImport({ tipo: 'potencial', arquivo: file.name, linhas: lista.length });
    await refresh();
    const com = rows.filter(l => l.poten != null).length;
    finishDialog('Potencial importado',
      `<dl><dt>CNPJs gravados</dt><dd>${fmtInt.format(lista.length)}</dd><dt>Lojas com potencial</dt><dd>${fmtInt.format(com)} de ${fmtInt.format(rows.length)}</dd></dl>`);
  } catch (err) { fail('Erro ao importar potencial', err); }
}

async function logImport(rec) {
  const { data } = await sb.auth.getUser();
  const { error } = await sb.from('importacoes').insert({ ...rec, usuario: data?.user?.email || null });
  if (error) console.warn('Não foi possível registrar a importação:', error.message);
}

})();
