const DEFAULT_TARGET_NICK = '애교용';

let PROXY_URL = '';

document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('url');
  const nickInput = document.getElementById('nick');
  const goBtn = document.getElementById('goBtn');
  const copyBtn = document.getElementById('copyBtn');
  const status = document.getElementById('status');
  const resultLink = document.getElementById('resultLink');
  const useProxyBtn = document.getElementById('useProxyBtn');

  function setStatus(text, cls='secondary') {
    status.className = 'alert alert-' + cls;
    status.textContent = text;
  }

  function normalizeNick(s) {
    if (!s && s!==0) return '';
    try { return s.normalize('NFKC').toLowerCase().trim(); }
    catch { return String(s).toLowerCase().trim(); }
  }

  function parseIdsFromUrl(url) {
    try {
      let m = url.match(/\/station\/([^/]+)\/post\/(\d+)/);
      if (m) return { sid: m[1], tn: m[2] };
      let m2 = url.match(/\/([^/]+)\/post\/(\d+)/);
      if (m2) return { sid: m2[1], tn: m2[2] };
      let m3 = url.match(/\/post\/(\d+)/);
      if (m3) return { sid: '', tn: m3[1] };
    } catch(e){}
    return { sid: null, tn: null };
  }

  function buildCommentUrl(sid, titleNo, page) {
    const base = sid ? `https://chapi.sooplive.co.kr/api/${sid}/title/${titleNo}/comment` : `https://chapi.sooplive.co.kr/api/title/${titleNo}/comment`;
    return page ? `${base}?page=${page}` : base;
  }
  function buildReplyUrl(sid, titleNo, parentNo) {
    const base = sid ? `https://chapi.sooplive.co.kr/api/${sid}/title/${titleNo}/comment/${parentNo}/reply` : `https://chapi.sooplive.co.kr/api/title/${titleNo}/comment/${parentNo}/reply`;
    return base;
  }
  function makePostUrl(basePath, sid, titleNo, commentNo) {
    const prefix = basePath ? (basePath.replace(/^\/|\/$/g, '') + '/') : (sid ? (String(sid).replace(/^\/|\/$/g,'') + '/') : '');
    const commentHash = commentNo ? `#comment_noti${commentNo}` : '';
    return `https://www.sooplive.co.kr/${prefix}post/${titleNo}${commentHash}`;
  }

  async function fetchJson(url, opts={}) {
    // if PROXY_URL configured, use it (worker should forward)
    let finalUrl = url;
    if (PROXY_URL) {
      // we use worker as a simple forwarder: GET {PROXY_URL}?url=<encoded target>
      finalUrl = `${PROXY_URL}?url=${encodeURIComponent(url)}`;
    }
    const res = await fetch(finalUrl, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchAllComments(sid, tn, maxPages=50) {
    // 1) fetch meta (first page) to get last_page if present
    const firstUrl = buildCommentUrl(sid, tn);
    let first = await fetchJson(firstUrl);
    let lastPage = 1;
    if (first && typeof first === 'object') {
      lastPage = (first.meta && first.meta.last_page) ? Number(first.meta.last_page) : 1;
      // some endpoints return data array directly
    }
    if (!lastPage || lastPage < 1) lastPage = 1;
    lastPage = Math.min(lastPage, maxPages);

    // build all page urls
    const pageUrls = [];
    for (let p=1;p<=lastPage;p++) pageUrls.push(buildCommentUrl(sid, tn, p));

    // fetch all pages in parallel
    const promises = pageUrls.map(u => fetchJson(u).catch(e => { console.warn('page fetch fail',u,e); return null; }));
    const results = await Promise.all(promises);

    // parse comments lists
    const comments = [];
    for (const raw of results) {
      if (!raw) continue;
      const rawList = (raw.data || raw.comments || []);
      if (Array.isArray(rawList)) {
        for (const c of rawList) {
          if (!c || typeof c !== 'object') continue;
          const user_nick = c.user_nick || c.user_name || c.nick || c.nickname || c.name || c.writer || '';
          const comment_no = c.p_comment_no || c.c_comment_no || c.comment_no || c.id || c.no || null;
          const comment_text = c.comment || c.content || c.body || c.message || c.text || '';
          comments.push({ user_nick, comment_no, comment: comment_text, c_comment_cnt: c.c_comment_cnt || 0 });
        }
      }
    }

    // find parents with replies and fetch them too
    const parentIds = [...new Set(comments.filter(x=>x.c_comment_cnt>0 && x.comment_no).map(x=>x.comment_no))];
    if (parentIds.length>0) {
      const replyUrls = parentIds.map(pid => buildReplyUrl(sid, tn, pid));
      const rp = replyUrls.map(u => fetchJson(u).catch(e=>{ console.warn('reply fetch fail',u,e); return null; }));
      const rres = await Promise.all(rp);
      for (const raw of rres) {
        if (!raw) continue;
        const rawList = raw.data || [];
        for (const c of rawList) {
          comments.push({ user_nick: c.user_nick || '', comment_no: c.c_comment_no || c.comment_no || null, comment: c.comment || '' });
        }
      }
    }

    return comments;
  }

  async function pickHighlight(url) {
    setStatus('파싱 중...', 'info');
    const { sid, tn } = parseIdsFromUrl(url);
    if (!tn) throw new Error('URL에서 title_no를 찾을 수 없습니다.');
    // attempt to extract base path for post URL (like station/.../post)
    const m = url.match(/https?:\/\/[^\/]+\/([^\/]+\/[^\/]+)\/post\//);
    const basePath = m ? m[1] : '';
    const items = await fetchAllComments(sid, tn, 50);
    const targetNorm = normalizeNick(nickInput.value || DEFAULT_TARGET_NICK);
    for (const it of items) {
      if (normalizeNick(it.user_nick) === targetNorm) {
        const link = makePostUrl(basePath, sid, tn, it.comment_no);
        return { found: true, link };
      }
    }
    return { found: false, link: makePostUrl(basePath, sid, tn, null) };
  }

  goBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) { setStatus('URL을 입력하세요', 'warning'); return; }
    resultLink.value = '';
    setStatus('검색중...', 'info');
    try {
      const res = await pickHighlight(url);
      resultLink.value = res.link || '';
      if (res.found) setStatus('하이라이트 댓글을 찾았습니다. (자동 복사 시도)', 'success');
      else setStatus('일치하는 댓글 없음 — 게시글 링크만 제공', 'secondary');

    
      try {
        if (resultLink.value) {
          await navigator.clipboard.writeText(resultLink.value);
          setStatus(res.found ? '하이라이트 링크 자동 복사됨' : '게시글 링크 자동 복사됨', 'success');
        }
      } catch(e) {
        console.warn('clipboard failed', e);
      }
    } catch (e) {
      console.error(e);
      if (e.message && e.message.toLowerCase().includes('failed to fetch')) {
        setStatus('요청 실패(가능한 CORS 문제). 프록시 사용을 고려하세요.', 'danger');
      } else {
        setStatus('오류: ' + e.message, 'danger');
      }
    }
  });

  copyBtn.addEventListener('click', async () => {
    if (!resultLink.value) { setStatus('복사할 링크가 없습니다', 'warning'); return; }
    try {
      await navigator.clipboard.writeText(resultLink.value);
      setStatus('클립보드에 복사되었습니다', 'success');
    } catch (e) {
      setStatus('복사 실패: ' + e.message, 'danger');
    }
  });

  useProxyBtn.addEventListener('click', async () => {
   
    const current = PROXY_URL || '(직접 호출)';
    const input = prompt('프록시(Cloudflare Worker 등) 베이스 URL을 입력하세요.\n예: https://your-worker.example.workers.dev\n비워두면 직접 호출로 돌아갑니다.', PROXY_URL);
    if (input === null) return;
    PROXY_URL = (input || '').trim();
    setStatus(PROXY_URL ? `프록시 사용: ${PROXY_URL}` : '직접 API 호출 모드', 'info');
  });

});

