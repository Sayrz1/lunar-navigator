// Navi: a small helper that answers from the page's own data. It matches keywords
// (English and Arabic) to a handful of questions; there is no language model behind it.

import { t } from '../i18n.js';

const INTENTS = [
  ['power', /battery|power|energy|kwh|watt|بطارية|طاقة|واط/i],
  ['score', /score|grade|rating|rank|تقييم|درجة|ترتيب/i],
  ['sun', /sun ?(rise|set)|sunlight|daylight|dark|night|light|شروق|غروب|الشمس|ضوء|ظلام|ليل/i],
  ['earth', /earth|radio|contact|signal|comm|الأرض|اتصال|إشارة|لاسلكي/i],
  ['best', /best|which (region|site)|where.*land|recommend|أفضل|أنسب|أين أهبط/i],
  ['window', /window|when.*land|date|plan|late|delay|نافذة|متى أهبط|موعد|تأخ/i],
  ['ice', /ice|water|shadow|psr|cold|جليد|ماء|ظل دائم|بارد/i],
  ['trust', /accura|trust|sure|source|data|valid|how do you know|دقة|دقيق|مصدر|بيانات|موثوق/i],
  ['slope', /slope|steep|flat|rough|ميل|منحدر|انحدار|مستو/i],
];

export function createNavi(answer) {
  const $ = id => document.getElementById(id);
  const panel = $('navi'), log = $('navi-log'), form = $('navi-form'), input = $('navi-input'), fab = $('navi-open');

  const say = (text, me = false) => {
    const li = document.createElement('li');
    if (me) li.className = 'me';
    li.textContent = text;
    log.append(li);
    log.scrollTop = log.scrollHeight;
  };

  const ask = q => {
    say(q, true);
    const hit = INTENTS.find(([, re]) => re.test(q));
    say(answer(hit ? hit[0] : 'unknown'));
  };

  const chips = () => {
    $('navi-chips').replaceChildren(...t('navi.chips').split('|').map(label => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = label;
      b.addEventListener('click', () => ask(label));
      return b;
    }));
  };

  const open = show => {
    panel.hidden = !show;
    fab.setAttribute('aria-expanded', String(show));
    if (show) {
      if (!log.children.length) say(t('navi.hello'));
      input.focus();
    }
  };

  for (const b of document.querySelectorAll('[data-open-navi]')) b.addEventListener('click', () => open(panel.hidden));
  $('navi-close').addEventListener('click', () => { open(false); fab.focus(); });
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') { open(false); fab.focus(); } });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) { ask(q); input.value = ''; }
  });
  chips();

  // called after a language switch
  return {
    relabel() {
      chips();
      log.replaceChildren();
      if (!panel.hidden) say(t('navi.hello'));
    },
  };
}
