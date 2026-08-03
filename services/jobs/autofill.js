/**
 * One click, every field filled — in YOUR browser.
 *
 * WHY IT IS NOT A HEADLESS ROBOT. Every ATS that matters gates its form:
 * Greenhouse runs an invisible reCAPTCHA, Lever loads hCaptcha and blocks the
 * submit button until it holds a token, Ashby renders the whole form in React
 * behind reCAPTCHA. Verified by reading their live pages, not assumed.
 *
 * A server-side headless browser scores badly on invisible reCAPTCHA and gets
 * dropped — silently. That failure is worse than not building it: the
 * applications never arrive, you believe they did, and your callback rate
 * fills with ghosts, which corrupts the one number that makes the odds on the
 * console honest rather than a guess.
 *
 * In your own browser none of that happens. You are a real person with real
 * history; the invisible check passes and you are never challenged. So this
 * fills every field from your profile — including attaching the actual resume
 * file — and stops. You press Submit. That is one click instead of twenty
 * minutes, which is the whole of the value, and it is real.
 *
 * It deliberately does NOT click submit. Not timidity: the CAPTCHA token is
 * issued against a real interaction, and an application sent without one is an
 * application that was not sent.
 */

/** Per-vendor field maps, written from the vendors' real live markup. */
const ADAPTERS = {
  // Server-rendered, stable ids. Read from a live Greenhouse board.
  greenhouse: {
    match: h => /greenhouse\.io/.test(h),
    fields: {
      firstName: ['#first_name'],
      lastName: ['#last_name'],
      fullName: [],
      email: ['#email'],
      phone: ['#phone'],
      location: ['#country', 'input[autocomplete="address-level2"]'],
      resume: ['#resume', 'input[type=file][name*=resume]'],
      coverLetter: ['#cover_letter']
    }
  },
  // One "name" field rather than two, and the file input is hidden behind a
  // styled label — hence targeting it by id rather than by what is visible.
  lever: {
    match: h => /lever\.co/.test(h),
    fields: {
      fullName: ['input[name="name"]'],
      email: ['input[name="email"]'],
      phone: ['input[name="phone"]'],
      location: ['input[name="location"]'],
      org: ['input[name="org"]'],
      resume: ['#resume-upload-input', 'input[type=file][name="resume"]']
    }
  },
  // React, so nothing is in the served HTML and fields must be found at
  // runtime by their labels rather than by id.
  ashby: {
    match: h => /ashbyhq\.com/.test(h),
    byLabel: true,
    fields: {
      fullName: ['input[name*="name" i]'],
      email: ['input[type=email]', 'input[name*="email" i]'],
      phone: ['input[type=tel]', 'input[name*="phone" i]'],
      resume: ['input[type=file]']
    }
  },
  workable: {
    match: h => /workable\.com/.test(h),
    fields: {
      firstName: ['input[name="firstname"]'],
      lastName: ['input[name="lastname"]'],
      email: ['input[name="email"]'],
      phone: ['input[name="phone"]'],
      resume: ['input[type=file]']
    }
  }
};

/**
 * The script the bookmarklet loads.
 *
 * Served as text rather than bundled so it can be regenerated when a vendor
 * moves a field, without anybody reinstalling anything.
 */
function autofillScript() {
  return `(function(){
  'use strict';
  var CFG = window.__CW_JOBS__;
  if (!CFG) { alert('Clockwork: no config — regenerate the bookmarklet.'); return; }

  function toast(msg, bad) {
    var d = document.getElementById('cw-af-toast') || document.createElement('div');
    d.id = 'cw-af-toast';
    d.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:18px;transform:translateX(-50%);'
      + 'background:' + (bad ? '#3a1114' : '#0d1b21') + ';color:' + (bad ? '#ffb4b4' : '#22d3ee')
      + ';border:1px solid ' + (bad ? '#ff5656' : '#22d3ee') + ';border-radius:10px;padding:12px 18px;'
      + 'font:13px/1.5 -apple-system,Segoe UI,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:min(560px,90vw)';
    d.textContent = msg;
    if (!d.parentNode) document.body.appendChild(d);
    clearTimeout(d._t); d._t = setTimeout(function(){ d.remove(); }, 9000);
  }

  var ADAPTERS = ${JSON.stringify(Object.fromEntries(
    Object.entries(ADAPTERS).map(([k, v]) => [k, { fields: v.fields, byLabel: !!v.byLabel }])
  ))};
  var HOST = location.hostname;
  var vendor = HOST.indexOf('greenhouse') > -1 ? 'greenhouse'
             : HOST.indexOf('lever') > -1 ? 'lever'
             : HOST.indexOf('ashby') > -1 ? 'ashby'
             : HOST.indexOf('workable') > -1 ? 'workable' : null;
  if (!vendor) { toast('Clockwork does not know this form yet (' + HOST + '). Nothing was changed.', true); return; }

  function find(sels) {
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el) return el;
    }
    return null;
  }
  // Some forms find fields only by their visible label — React ones especially,
  // where names are generated and ids change between deploys.
  function findByLabel(re, type) {
    var all = [].slice.call(document.querySelectorAll('input,textarea'));
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (type && e.type !== type) continue;
      var lab = (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.placeholder || e.name || '';
      if (re.test(lab)) return e;
    }
    return null;
  }

  // React and Vue ignore a plain value assignment: they track the value on the
  // node's own descriptor, so setting .value directly is reverted on the next
  // render and the field submits empty. This is the setter they listen to.
  function setValue(el, val) {
    if (!el || val == null || val === '') return false;
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.style.outline = '2px solid #22d3ee';
    setTimeout(function(){ el.style.outline = ''; }, 2500);
    return true;
  }

  var A = ADAPTERS[vendor], F = A.fields, filled = [], missed = [];
  function put(key, val, labelRe, type) {
    if (!val) return;
    var el = (F[key] && F[key].length ? find(F[key]) : null) || (labelRe ? findByLabel(labelRe, type) : null);
    if (el && setValue(el, val)) filled.push(key); else if (el === null) missed.push(key);
  }

  put('firstName', CFG.firstName, /first name/i, 'text');
  put('lastName', CFG.lastName, /last name|surname/i, 'text');
  put('fullName', CFG.fullName, /^(full )?name$/i, 'text');
  put('email', CFG.email, /e-?mail/i);
  put('phone', CFG.phone, /phone|mobile/i);
  put('location', CFG.location, /location|city/i, 'text');
  put('org', CFG.org, /current company|employer|organi[sz]ation/i, 'text');

  // Links are asked for under a dozen different names; fill whichever exist.
  [[/linkedin/i, CFG.linkedin], [/github/i, CFG.github], [/portfolio|website|personal site/i, CFG.website]]
    .forEach(function (pair) {
      if (!pair[1]) return;
      var el = findByLabel(pair[0]);
      if (el && setValue(el, pair[1])) filled.push('link');
    });

  function afterResume() {
    var note = 'Filled ' + filled.length + ' field' + (filled.length === 1 ? '' : 's')
      + (missed.length ? ' · ' + missed.length + ' not found on this page' : '')
      + '. Check it, then press Submit yourself — the anti-bot check needs your click.';
    toast(note, false);
  }

  // The resume. input.files is read-only, but a DataTransfer built from real
  // bytes is accepted — this attaches the actual file, not a filename.
  if (CFG.resumeUrl) {
    var fileEl = (F.resume && find(F.resume)) || document.querySelector('input[type=file]');
    if (!fileEl) { missed.push('resume'); afterResume(); }
    else {
      // A hard timeout, because a hanging fetch is worse than a failed one:
      // without it the whole script stops at the resume step and you get no
      // toast at all, so a filled form looks like a script that never ran.
      var ctl = new AbortController();
      var killer = setTimeout(function () { ctl.abort(); }, 15000);
      fetch(CFG.resumeUrl, { headers: { 'X-CW-Token': CFG.token }, signal: ctl.signal })
        .then(function (r) { clearTimeout(killer); if (!r.ok) throw new Error('resume ' + r.status); return r.blob(); })
        .then(function (b) {
          var f = new File([b], CFG.resumeName || 'resume.pdf', { type: b.type || 'application/pdf' });
          var dt = new DataTransfer();
          dt.items.add(f);
          fileEl.files = dt.files;
          fileEl.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push('resume');
          afterResume();
        })
        .catch(function (e) {
          clearTimeout(killer);
          toast('Filled ' + filled.length + ' fields, but the resume did not attach ('
            + (e.name === 'AbortError' ? 'timed out' : e.message) + ') — attach it yourself, then Submit.', true);
        });
    }
  } else afterResume();
})();`;
}

/** The one-liner that goes on the bookmarks bar. */
function bookmarklet(apiBase, token) {
  const src = `${apiBase}/api/v1/jobs/autofill.js?t=${encodeURIComponent(token)}`;
  return `javascript:(function(){var s=document.createElement('script');s.src='${src}&_='+Date.now();document.body.appendChild(s);})();`;
}

module.exports = { ADAPTERS, autofillScript, bookmarklet };
