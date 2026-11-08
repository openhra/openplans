/** Independent expectations arrive from Python Decimal/CSV; this module only runs the subject. */
import { dentalPremium } from '../../dist/domain/rating/dental.js';
export const member = (age, relationship = 'subscriber', tobaccoUse = false, id = 's') => ({ id, age, relationship, tobaccoUse });
export const household = (members, date, method = 'per_member') => ({ members, coverageStartDate: date, ratingMethod: method });
export const familyMembers = (children, spouse = false) => [member(35), ...(spouse ? [member(40,'spouse',true,'p')] : []),
  ...Array.from({length:children}, (_,i) => member(10,'child',false,`c${i}`))];

/** Read independently from raw BR fields, not the application's rule resolver. */
export function unsupportedMembership(expected, members, rules) {
  if(expected.market !== 'Individual' || ['NY','VT'].includes(expected.state)) return true;
  const agreed = key => rules.length && new Set(rules.map(r=>r.raw[key])).size === 1 ? rules[0].raw[key] : undefined;
  if(agreed('AgeDeterminationRule') !== 'Age on effective date') return true;
  const children = members.filter(m=>m.relationship==='child'), maximum=agreed('DependentMaximumAgRule');
  if(children.length && (!/^\d+$/.test(maximum ?? '') || children.some(m=>m.age>Number(maximum)))) return true;
  if(members.some(m=>rules.some(r=>!r.raw.CohabitationRule?.split(';').includes(
    ({subscriber:'Self,Yes',spouse:'Spouse,No',child:'Child,No'})[m.relationship])))) return true;
  if(expected.age === 'Family Option') return expected.tobacco === 'Tobacco User/Non-Tobacco User' || expected.tobacco_price != null;
  return !/^[123]$/.test(agreed('MaximumUnderageDependent') ?? '');
}

export function checkDentalRow(expected, rows, rules, rate = dentalPremium) {
  const comparisons = [], failures = [];
  const test = (members, column, cents, date, method) => {
    const result = rate(rows,expected.plan,expected.area,household(members,date,method),expected.state,rules,expected.market);
    const supported = !unsupportedMembership(expected,members,rules);
    const wantStatus = !supported ? 'unsupported_rating_method' : cents === null ? 'unknown' : 'rated';
    const match = result.status === wantStatus && result.totalCents === (supported ? cents : null)
      && (!supported || result.rowsUsed.some(r => r.provenance.sourceRowNumber === expected.source_row))
      && (!supported || wantStatus !== 'rated' || method !== 'family_tier' || result.filedColumn === column);
    const entry = { source_row:expected.source_row,plan:expected.plan,area:expected.area,column,date,
      members,expected_cents:supported?cents:null,actual_cents:result.totalCents,status:result.status,expected_status:wantStatus };
    comparisons.push(entry);
    if(!match) failures.push(entry);
  };
  if(expected.age === 'Family Option') {
    // Explicit expectations, independent of the production suffix/count mapping.
    for(const [spouse,count,column] of [[false,0,'IndividualRate'],[true,0,'Couple'],[false,1,'PrimarySubscriberAndOneDependent'],
      [false,2,'PrimarySubscriberAndTwoDependents'],[false,3,'PrimarySubscriberAndThreeOrMoreDependents'],
      [false,4,'PrimarySubscriberAndThreeOrMoreDependents'],[true,1,'CoupleAndOneDependent'],[true,2,'CoupleAndTwoDependents'],
      [true,3,'CoupleAndThreeOrMoreDependents'],[true,4,'CoupleAndThreeOrMoreDependents']]) {
      for(const date of new Set([expected.effective,expected.expiration])) test(familyMembers(count,spouse),column,expected.prices[column],date,'family_tier');
    }
  } else {
    const ages = expected.age === '0-14' ? Array.from({length:15},(_,i)=>i)
      : expected.age === '64 and over' ? [64,65,80,120] : [Number(expected.age)];
    for(const age of ages) for(const tobacco of [false,true]) for(const date of new Set([expected.effective,expected.expiration])) {
      const column = tobacco && expected.tobacco !== 'No Preference' ? 'IndividualTobaccoRate' : 'IndividualRate';
      test([member(age,'subscriber',tobacco)],column,column === 'IndividualRate' ? expected.prices.IndividualRate : expected.tobacco_price,date,'per_member');
    }
  }
  return { comparisons:comparisons.length, mismatches:failures };
}
