# Data Protection Impact Assessment – Fit to go medical

**Status:** DRAFT – prepared from how the website works. Fill in the parts in [square brackets], review the risk ratings with whoever advises you on data protection, then sign it off (section 7). Review it every year and whenever you change how patient data is used.

| | |
|---|---|
| Organisation (data controller) | [Legal name, company number] |
| Address | [Registered address] |
| ICO registration number | [ZA…] |
| Person responsible for data protection | [Name, role, email] |
| Date of this assessment | [Date] |
| Next review | [Date + 12 months] |

---

## 1. Why a DPIA is needed

The website processes **health data** (a "special category" under UK GDPR Article 9) about patients, on a large scale over time, using online services. The ICO lists processing of special category data as likely to result in high risk, so a DPIA is required before the service goes live.

## 2. Description of the processing

### 2.1 Nature – what happens to the data

| Step | Data involved | Who can see it |
|---|---|---|
| Patient creates an account | Name, email, phone (optional), date of birth (optional), password (stored only as a bcrypt hash) | The patient; admins |
| Patient books and pays | Test chosen, clinic, date and time, price. Card details are entered on **Stripe's** page and never reach our systems | The patient; the doctor for that appointment; admins |
| Check-in and consultation | Vital signs, medical history (medications, allergies, conditions, smoking, alcohol, recent illness), test findings, sample IDs, outcome (fit / unfit etc.), a summary for the patient and private clinical notes | The examining doctor; other doctors only if given the "view patient history" permission; admins. The patient sees everything except the private clinical notes |
| Documents | A PDF medical report and certificate, produced when the appointment is completed | The patient (download, and by email if email is set up, protected with a password: their date of birth); the doctor; admins |
| Security and audit records | Sign-ins, failed staff sign-ins (with IP address), and who viewed or changed records | Admins |

### 2.2 Scope

- **Data subjects:** patients (adults booking their own tests – [confirm: do you see under-18s?]) and clinic staff.
- **Volume:** about [number] patients a year.
- **Retention:** medical records for [8] years after the last appointment; payment records for [6] years; audit log for [2] years. Patients can ask for deletion. Identifying details are then removed ("anonymised") while the records the law requires are kept.
- **Location of data:**
  - Database: Neon, [region, e.g. AWS London/Frankfurt].
  - Website hosting: Render, Frankfurt (EU).
  - Payments: Stripe.
  - Email: [provider].

### 2.3 Context

- **What patients expect:** patients expect a medical clinic to hold their health data for their care and to keep it confidential.
- **Who handles it:** staff are GMC-registered doctors and clinic administrators, under a duty of confidentiality.
- **Children:** [If the clinic sees children, add how parental consent and access are handled.]

### 2.4 Purposes

Provide medical tests and certificates, take payment, give patients their results, keep the records required by law and professional guidance, and keep the service secure.

## 3. Consultation

[Record who you consulted, e.g. the clinical lead, IT or web support, an external data-protection adviser, and patient feedback if any.]

## 4. Necessity and proportionality

- **Lawful basis for processing:**
  - Account and booking data: contract, Art. 6(1)(b).
  - Records kept for legal reasons: legal obligation, Art. 6(1)(c).
  - Security logs: legitimate interests, Art. 6(1)(f).
- **Condition for health data:** Art. 9(2)(h), medical diagnosis and provision of health care, by or under the responsibility of a health professional bound by confidentiality (Data Protection Act 2018, Sch. 1 Part 1 para 2).
- **Data minimisation:**
  - The consultation form only asks for what the test needs, and every field is optional apart from the outcome.
  - Phone and date of birth are optional at sign-up.
  - Card details are never collected.
- **Accuracy:** patients can correct their details under *My details*. Doctors can correct a completed record, and the documents then show that it was amended.
- **Transparency:** there is a privacy policy at `/privacy`, linked from sign-up and every page.
- **Individual rights:**
  - Right of access: *Download my data*.
  - Erasure: *Request account deletion*, handled under **Admin → Requests** with the one-month deadline shown.
  - Rectification: by editing *My details*, or by contacting the clinic.
- **Processors:** each has a data-processing agreement: Neon [✔ signed / date], Render [ ], Stripe [ ], [email provider] [ ].
- **International transfers:** [State whether any provider stores or accesses data outside the UK, and the safeguard used, e.g. UK adequacy regulations for the EU, or the International Data Transfer Agreement.]

## 5. Risks

Likelihood and severity: Remote / Possible / Probable, and Minimal / Significant / Severe.

| # | Risk to individuals | Likelihood | Severity | Overall |
|---|---|---|---|---|
| R1 | Someone gets into a patient's account and sees their results (e.g. a guessed or reused password) | Possible | Significant | Medium |
| R2 | Someone gets into a staff account and sees many patients' records | Possible | Severe | High |
| R3 | A patient sees another patient's records because of a software fault | Remote | Severe | Medium |
| R4 | Data intercepted in transit (website ↔ browser, website ↔ database) | Remote | Severe | Low |
| R5 | Database breach at the hosting provider | Remote | Severe | Medium |
| R6 | Emailed documents go to the wrong person or an intercepted mailbox | Possible | Significant | Medium |
| R7 | Results left visible on a shared or public computer | Possible | Significant | Medium |
| R8 | Data lost (deletion, provider failure) and records unavailable | Remote | Significant | Low |
| R9 | Data kept longer than necessary | Possible | Minimal | Low |
| R10 | Staff access records they don't need (curiosity, misuse) | Possible | Significant | Medium |

## 6. Measures to reduce the risks

| Risk | Measures in place (already built into the website) | Further action by the clinic | Residual risk |
|---|---|---|---|
| R1 | Passwords hashed with bcrypt; limits on guessing per account and per connection; sign-in pages don't reveal which emails have accounts; single-use password-reset links valid for 1 hour; changing a password signs out other devices | Encourage patients to use strong, unique passwords | Low |
| R2 | Separate staff sign-in page; staff pages hidden ("Page not found") from everyone else; temporary passwords must be replaced with 12+ characters; sign-out after 30 minutes of inactivity; 5-attempt limit; failed staff sign-ins logged; deactivating a staff member signs them out everywhere; optional restriction to the clinic's internet connection (`STAFF_ALLOWED_IPS`) | One account per person, never shared; accounts closed the day someone leaves; use a password manager. **Consider re-enabling two-step sign-in for admins.** | Medium → Low with two-step sign-in |
| R3 | Every page and document checks that the signed-in person is allowed to see that record; automated tests check that patients can't open other patients' documents; tests run automatically on every change | [Independent penetration test before launch] | Low |
| R4 | HTTPS enforced on the live site with HSTS; database connection encrypted with certificate checking | – | Low |
| R5 | Provider encryption at rest (Neon); secrets held only in the hosting provider's settings, never in the code | Choose UK/EU regions; enable two-step sign-in on the Neon, Render, Stripe and GitHub accounts; keep the GitHub repository private | Low |
| R6 | PDF attachments password-protected with the patient's date of birth; if no date of birth is on file, only a link is sent | Confirm the patient's email at the first appointment | Low |
| R7 | Pages with personal data are never stored in the browser cache; staff are signed out after 30 minutes of inactivity | Remind staff to sign out on shared computers | Low |
| R8 | Hosted database with provider backups; only additive changes to the database structure | Enable point-in-time restore / backups on Neon and **test a restore** | Low |
| R9 | Patients can request deletion; admins can remove identifying details | Set a yearly reminder to review and remove records past the retention period | Low |
| R10 | Doctor permissions set per person (e.g. patient history can be switched off); audit log of record views, document downloads and changes | Admins review the audit log [monthly]; staff confidentiality training | Low |

## 7. Sign-off

| Item | Name / date | Notes |
|---|---|---|
| Measures approved by | | Integrate the actions above into the go-live plan |
| Residual risks approved by | | If any high risk remains, consult the ICO before going live |
| Data protection adviser's advice | | |
| Advice accepted or overruled | | If overruled, record why |
| This DPIA will be kept under review by | | |
