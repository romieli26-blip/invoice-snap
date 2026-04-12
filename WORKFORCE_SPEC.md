# Workforce Management Module - Specification

## Overview
Add time reporting, document management, and contractor support to the Jetsetter Reporting App.

## New Roles
| Role | Access |
|---|---|
| super_admin | Everything (existing) |
| admin | Everything except impersonation (existing) |
| manager | Receipts + Cash + Time Reporting + Documents |
| contractor | Time Reporting + Documents ONLY (no receipts/cash) |

## User Profile Changes
- `displayName` → `firstName` + `lastName` (display = "FirstName LastName")
- `baseRate` (hourly rate at home property)
- `offSiteRate` (hourly rate at non-home properties, if allowed)
- `homeProperty` (their main/base property)
- `allowOffSite` (admin checkbox: can they work at other properties?)
- `mileageRate` (default $0.50/mile, admin can change per user)
- `allowSpecialTerms` (admin checkbox: can they claim travel expenses?)
- `specialTermsAmount` (daily max for travel expenses like meals)

## Time Reporting
### Data Model: `time_reports` table
- id, userId, property, date
- startTime (HH:MM), endTime (HH:MM)
- accomplishments (JSON array of text entries)
- miles (number, optional)
- mileageAmount (calculated: miles × mileageRate)
- specialTerms (boolean), specialTermsAmount
- notes (free text)
- createdAt

### Rules
- Can report for today or yesterday ONLY
- No future dates → error
- No 2+ days back → "Contact your Asset Manager"
- Multiple accomplishment entries via "+" button
- Greyed placeholder examples: "Fixed leak in unit 5B", "Eviction process unit 3A", "Reservation calls"
- Miles calculated at user's mileage rate
- Special terms only if admin enabled it for that user

### User Experience
1. New button on home screen: "Work Reporting" (blue)
2. Select property (auto if only one, dropdown if multiple)
3. Select date (today or yesterday)
4. Enter start time, end time
5. Enter accomplishments (multiple entries)
6. Miles? If yes, enter number → auto-calculates pay
7. Special terms? If enabled, enter amount (capped at user's limit)
8. Notes (free text)
9. Confirmation → Submit

## User Documents
### Toggle button: "User Docs"
- Three categories: Photo ID, Banking Info, W9/W4
- Each can be uploaded (photo or scan)
- Banking: Bank Name, Routing Number, Account Number (manual or scan)
- W9 or W4 (admin selects which one applies per user)
- Green highlight when all 3 complete, grey if incomplete

### Storage
Each user gets a Google Drive folder: `Time Reporting/PropertyName_FirstName_LastName/`
- Inside: `Documents/` (ID, banking, tax forms)
- Inside: `Time Reports/` (daily entries)

## Reports
### Daily Workforce Report (midnight ET)
- All users who reported time that day
- Hours worked, accomplishments, miles, special terms
- Sent to subscribed admins

### Admin On-Demand Report
- Select user + date range
- Shows: dates worked, total hours, miles, mileage pay, special terms, accomplishments
- Exportable

## Contractor Role
- Sees ONLY: Work Reporting + User Docs
- No receipts, cash transactions, or reconciliation
- Can work at multiple properties (assigned by admin)
- Same time reporting interface as managers

## Google Drive Structure
```
Time Reporting/
  Bonifay_John_Smith/
    Documents/
      photo-id.jpg
      banking-info.jpg
      w9.pdf
    Time Reports/
      2026-04-12.html
  Sunchase_Jane_Doe/
    ...
```

## App Rename
- "Receipt App" → "Jetsetter Reporting" everywhere
- Login page, header, emails, all UI text
