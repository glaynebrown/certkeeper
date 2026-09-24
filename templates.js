/* Starter templates for the "Add a certification" screen. Picking one fills
   in the issuer, links and renewal rule; the user adds their own number and
   dates, and can change anything. Rules were checked against each issuer's
   site in Sept 2026 -- if an issuer changes its rules, update them here. */
const TEMPLATES = [
  // ---- Nursing ----
  // State licenses: picking a state fills in that board. States listed in
  // byState have their details filled in; any other state gets
  // "<State> Board of Nursing" plus a link to that board's NCSBN contact page.
  {
    id: 'rn', group: 'Nursing',
    name: 'Registered Nurse', abbr: 'RN', issuer: 'Board of Nursing',
    validityMonths: 24, renewalRule: 'fixed',
    askState: true, boardName: 'Board of Nursing',
    stateLink: state => `https://www.ncsbn.org/bon-member-details/${state.replace(/ /g, '')}`,
    requirements: 'Renewal timing and continuing-education rules vary by state. Check with your board of nursing.',
    byState: {
      VA: {
        renewLink: 'https://www.dhp.virginia.gov/Boards/Nursing/',
        instructionsLink: 'https://www.dhp.virginia.gov/Boards/Nursing/PractitionerResources/ContinuedCompetency/RNLPN/',
        requirements: 'Renew by the last day of your birth month every 2 years (even/odd year matches your birth year). Meet one continued-competency option, e.g. 30 contact hrs CE, or 15 hrs CE + 640 hrs active practice.',
      },
    },
  },

  // ---- EMS ----
  {
    id: 'nremt-emt', group: 'EMS',
    name: 'National Registry EMT', abbr: 'NREMT', issuer: 'National Registry of EMTs',
    validityMonths: 24, renewalRule: 'fixed',
    renewLink: 'https://www.nremt.org/',
    instructionsLink: 'https://www.nremt.org/EMT/Recertification',
    requirements: '40 hrs NCCP: 20 national, 10 local/state, 10 individual. Cycle ends March 31. Late application (with fee) until April 30, but CE must be finished by March 31.',
  },
  {
    id: 'nremt-paramedic', group: 'EMS',
    name: 'National Registry Paramedic', abbr: 'NRP', issuer: 'National Registry of EMTs',
    validityMonths: 24, renewalRule: 'fixed',
    renewLink: 'https://www.nremt.org/',
    instructionsLink: 'https://www.nremt.org/Paramedic/Recertification',
    requirements: '60 hrs NCCP: 30 national, 15 local/state, 15 individual. Cycle ends March 31.',
  },
  {
    id: 'va-emt', group: 'EMS',
    name: 'Virginia EMT', abbr: 'VA EMT', issuer: 'Virginia Office of EMS',
    validityMonths: 48, renewalRule: 'fixed',
    renewLink: 'https://www.vdh.virginia.gov/emergency-medical-services/',
    instructionsLink: 'https://www.vdh.virginia.gov/emergency-medical-services/education-certification/provider-resources/recertifying-your-virginia-ems-credential/virginia-recertification/',
    requirements: 'Virginia BLS certifications run 4 years. CE per Virginia OEMS; check your OEMS transcript for what’s left.',
  },
  {
    id: 'va-ec', group: 'EMS',
    name: 'Virginia EMS Education Coordinator', abbr: 'EC', issuer: 'Virginia Office of EMS',
    validityMonths: 36, renewalRule: 'fixed',
    renewLink: 'https://www.vdh.virginia.gov/emergency-medical-services/',
    instructionsLink: 'https://www.vdh.virginia.gov/emergency-medical-services/education-certification/educator-resources/ems-instructor-resources/ems-education-coordinator-recertification-requirements/',
    requirements: 'In the 3-year period: teach at least 50 hrs of initial certification or Category 1 CE, attend 1 EC update, then pass the EC recert exam. Everything must be submitted before expiration.',
  },

  // ---- Resuscitation / CPR ----
  {
    id: 'aap-nrp', group: 'Resuscitation & CPR',
    name: 'Neonatal Resuscitation Program', abbr: 'NRP', issuer: 'American Academy of Pediatrics',
    validityMonths: 24, renewalRule: 'classDate',
    renewLink: 'https://www.aap.org/en/pedialink/neonatal-resuscitation-program/',
    requirements: 'Online learning + exam, then an in-person instructor-led skills event. Good for 2 years.',
  },
  {
    id: 'aha-bls', group: 'Resuscitation & CPR',
    name: 'AHA BLS Provider (CPR)', abbr: 'AHA BLS', issuer: 'American Heart Association',
    validityMonths: 24, renewalRule: 'classDateEOM',
    renewLink: 'https://atlas.heart.org/',
    requirements: 'Card expires at the end of the month, 2 years after your class.',
  },
  {
    id: 'aha-bls-instructor', group: 'Resuscitation & CPR',
    name: 'AHA BLS Instructor', abbr: 'AHA Instructor', issuer: 'American Heart Association',
    validityMonths: 24, renewalRule: 'classDateEOM',
    renewLink: 'https://atlas.heart.org/',
    requirements: 'Teach at least 4 courses in 2 years, stay current on course updates, and renew (including monitoring) through your Training Center before the end of your expiration month.',
    trackerEnabled: true, trackerLabel: 'Courses taught', trackerUnit: 'classes', trackerTarget: 4,
  },
  {
    id: 'arc-cpr', group: 'Resuscitation & CPR',
    name: 'Red Cross CPR / BLS', abbr: 'ARC CPR', issuer: 'American Red Cross',
    validityMonths: 24, renewalRule: 'classDate',
    renewLink: 'https://www.redcross.org/take-a-class/bls-training/bls-renewal',
    requirements: 'Good for 2 years from the class date. Digital certificate is in your Red Cross account.',
  },
  {
    id: 'aha-acls', group: 'Resuscitation & CPR',
    name: 'AHA ACLS', abbr: 'ACLS', issuer: 'American Heart Association',
    validityMonths: 24, renewalRule: 'classDateEOM',
    renewLink: 'https://atlas.heart.org/',
    requirements: 'Card expires at the end of the month, 2 years after your class.',
  },
  {
    id: 'aha-pals', group: 'Resuscitation & CPR',
    name: 'AHA PALS', abbr: 'PALS', issuer: 'American Heart Association',
    validityMonths: 24, renewalRule: 'classDateEOM',
    renewLink: 'https://atlas.heart.org/',
    requirements: 'Card expires at the end of the month, 2 years after your class.',
  },

  // ---- Other ----
  // `label` is what the dropdown shows; the name is left blank to type in.
  {
    id: 'certificate', group: 'Other', label: 'Certificate (doesn’t expire)',
    name: '', abbr: '', issuer: '', noExpiry: true,
  },
];

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const stateName = code => US_STATES[code] || '';

// The template's fields, with the chosen state's board filled in.
function templateFields(t, stateCode) {
  const fields = {
    name: t.name, abbr: t.abbr, issuer: t.issuer, requirements: t.requirements || '',
    renewLink: t.renewLink || '', instructionsLink: t.instructionsLink || '',
    validityMonths: t.validityMonths, renewalRule: t.renewalRule,
    trackerEnabled: !!t.trackerEnabled, trackerLabel: t.trackerLabel || '',
    trackerUnit: t.trackerUnit || 'classes', trackerTarget: t.trackerTarget || '',
    noExpiry: !!t.noExpiry,
  };
  if (t.askState && stateCode && US_STATES[stateCode]) {
    Object.assign(fields, {
      issuer: `${stateName(stateCode)} ${t.boardName}`,
      renewLink: t.stateLink(US_STATES[stateCode]),
      instructionsLink: '',
    }, (t.byState || {})[stateCode]);
  }
  return fields;
}
