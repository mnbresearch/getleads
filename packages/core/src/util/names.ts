const HONORIFICS = /^(mr|mrs|ms|dr|prof|sir|er|ca|adv)\.?\s+/i;
const SUFFIXES = /,?\s+(phd|mba|cpa|ca|cfa|jr|sr|ii|iii|pmp|frm|acca)\.?$/i;

export function splitName(fullName: string): { firstName?: string; lastName?: string; fullName: string } {
  let n = fullName.replace(/\s+/g, " ").trim();
  n = n.replace(HONORIFICS, "").replace(SUFFIXES, "").replace(/[()"']/g, "").trim();
  const parts = n.split(" ").filter(Boolean);
  if (parts.length === 0) return { fullName: n };
  if (parts.length === 1) return { firstName: parts[0], fullName: n };
  return { firstName: parts[0], lastName: parts[parts.length - 1], fullName: n };
}

export function slugifyNamePart(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

const SENIORITY_RULES: [RegExp, string][] = [
  [/\b(founder|co-?founder|owner|ceo|cto|cfo|coo|cmo|cro|cpo|chief|president|managing director|md)\b/i, "c_level"],
  [/\b(vp|vice president|svp|evp)\b/i, "vp"],
  [/\b(head of|head,|director)\b/i, "director"],
  [/\b(manager|lead|principal)\b/i, "manager"],
  [/\b(senior|sr\.?)\b/i, "senior"],
  [/\b(intern|trainee|junior|jr\.?|associate|assistant)\b/i, "entry"],
];

export function inferSeniority(title?: string) {
  if (!title) return undefined;
  for (const [re, s] of SENIORITY_RULES) if (re.test(title)) return s;
  return "individual";
}

const DEPT_RULES: [RegExp, string][] = [
  [/\b(sales|business development|bd|account executive|sdr|bdr|revenue)\b/i, "sales"],
  [/\b(marketing|growth|brand|content|seo|demand gen)\b/i, "marketing"],
  [/\b(engineer|developer|cto|technology|software|architect|devops|data)\b/i, "engineering"],
  [/\b(product|pm\b|ux|design)\b/i, "product"],
  [/\b(finance|cfo|accounting|controller|treasury)\b/i, "finance"],
  [/\b(hr|human resources|people|talent|recruit)\b/i, "hr"],
  [/\b(operations|ops|coo|supply chain|logistics)\b/i, "operations"],
  [/\b(ceo|founder|owner|president|managing director|chief executive)\b/i, "executive"],
  [/\b(legal|counsel|compliance)\b/i, "legal"],
  [/\b(customer success|support|account manager)\b/i, "customer_success"],
];

export function inferDepartment(title?: string) {
  if (!title) return undefined;
  for (const [re, d] of DEPT_RULES) if (re.test(title)) return d;
  return undefined;
}
