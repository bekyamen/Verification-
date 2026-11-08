# CheckFlow ET - Payment Verification API Documentation

Welcome to the **CheckFlow ET** API reference. This API provides essential functionalities for user authentication, bank account management, and automated/manual payment verification supporting Commercial Bank of Ethiopia (CBE) and Telebirr.



## Base Information
- **Base URL:** `http://localhost:5000`
- **Content-Type:** `application/json` (except for file uploads)


### Global Headers
While authentication routes are public, most operations require a valid JWT token. Verification routes additionally require cashier-specific headers to ensure audit compliance.


| Header | Type | Description | Required On |
|--------|------|-------------|-------------|
| `Authorization` | String | Bearer token formatted as `Bearer <JWT_TOKEN>`. | Authenticated routes |
| `x-cashier-pin` | String | The PIN code of the cashier performing the transaction. | Verification routes |
| `x-branch-id` | UUID | The unique identifier of the active branch. | Verification routes |

---

## 1. Authentication Endpoints




### 1.1. User Registration
Registers a new user (OWNER) and generates an authentication token.

- **Endpoint:** `/api/auth/register`
- **Method:** `POST`

**Request Body (`application/json`)**
```json
{
  "fullName": "Abebe Kebede",
  "phone": "0911223355",
  "pinCode": "1234",
  "accountType": "BUSINESS"
}
```

**Success Response (`201 Created` / `200 OK`)**
```json
{
  "message": "Account created successfully",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "227408df-13d1-4726-a699-030aae2c9381",
    "fullName": "Abebe Kebede",
    "phone": "+251911223355",
    "role": "OWNER",
    "branchId": "0469cb29-dbb1-418c-9bc0-fffce3c2b04d",
    "organizationId": "b2f9fa40-51da-48b7-99ca-69bbd16508d8"
  }
}

```


### 1.2. User Login
Authenticates an existing user via phone number and PIN.

- **Endpoint:** `/api/auth/login`
- **Method:** `POST`

**Request Body (`application/json`)**
```json
{
  "phone": "0911223355",
  "pinCode": "1234"
}
```

**Success Response (`200 OK`)**
```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "227408df-13d1-4726-a699-030aae2c9381",
    "fullName": "Abebe Kebede",
    "phone": "+251911223355",
    "role": "OWNER",
    "branchId": "0469cb29-dbb1-418c-9bc0-fffce3c2b04d",
    "organizationId": "b2f9fa40-51da-48b7-99ca-69bbd16508d8"
  }
}
```

---

## 2. Setting / Account Management

### 2.1. Add Receiving Account
Registers a new receiving bank account (CBE) or wallet (Telebirr) for the organization.

- **Endpoint:** `/api/settings/accounts`
- **Method:** `POST`
- **Headers:** `Authorization` (Bearer Token)

**Request Body (`application/json`) - Example for CBE**
```json
{
  "bankName": "CBE",
  "accountNumber": "1000076330763",
  "accountHolderName": "Yordanos Lulu Kibret"
}
```

**Request Body (`application/json`) - Example for Telebirr**
```json
{
  "bankName": "TELEBIRR",
  "accountNumber": "0932571087",
  "accountHolderName": "SADA"
}
```

**Success Response (`200 OK` / `201 Created`)**
```json
{
  "account": {
    "id": "f1bb87bd-5e48-488e-8f79-fafd495d0262",
    "organizationId": "0af30bab-144e-410c-bdfe-ba2794e25cc7",
    "bankName": "CBE",
    "accountNumber": "1000076330763",
    "accountHolderName": "Yordanos Lulu Kibret",
    "isActive": true,
    "createdAt": "2026-10-09T11:46:46.176Z",
    "updatedAt": "2026-10-09T11:46:46.176Z",
    "createdById": "fb610958-707f-469a-8758-84f38bf6717d",
    "updatedById": "fb610958-707f-469a-8758-84f38bf6717d"
  }
}
```


---

## 3. Payment Verification Operations

### 3.1. Manual Verification
Manually validates a transaction ID/reference directly through backend checks.

- **Endpoint:** `/api/verify/manual`
- **Method:** `POST`
- **Headers:** 
  - `Authorization`
  - `x-cashier-pin` (Required)
  - `x-branch-id` (Required)

**Request Body (`application/json`) - Example CBE**
```json
{
  "provider": "CBE",
  "txnReference": "FT26282ND8WJ",
  "receivingAccount": "1000076330763"
}
```

**Request Body (`application/json`) - Example Telebirr**
```json
{
  "provider": "TELEBIRR",
  "txnReference": "DJ90KV28YU",
  "receivingAccount": "0932571087"
}
```

**Success Response (`200 OK`)** 
```json
{
  "id": "e1171283-c00f-4c96-8d93-0c6879cb436c",
  "branchId": "2ded358d-7450-4797-91c9-6b17122623b1",
  "cashierId": "fb610958-707f-469a-8758-84f38bf6717d",
  "provider": "TELEBIRR",
  "txnReference": "DJ90KV28YU",
  "amount": "0",
  "expectedAmount": null,
  "receivingAccount": "0932571087",
  "senderAccount": null,
  "payerPhone": null,
  "payerName": null,
  "receiptUrl": null,
  "receiptImageUrl": null,
  "status": "VERIFIED",
  "rawScannedText": "MANUAL_ENTRY",
  "verifiedAt": "2026-10-09T20:36:41.458Z"
}
```

### 3.2. Receipt Image Verification
Uploads a payment receipt image (screenshot) to extract and digitally verify transaction legitimacy.

- **Endpoint:** `/api/verify/image`
- **Method:** `POST`
- **Headers:** 
  - `Authorization`
  - `x-cashier-pin` (Required)
  - `x-branch-id` (Required)
- **Content-Type:** `multipart/form-data`

**Request Object (`multipart/form-data`)**
- `receipt`: The binary image file of the receipt (e.g., JPEG, PNG).

**Success Response for CBE Image (`200 OK`)**
```json
{
  "id": "4e2a344a-c898-4b79-99e2-7b126f1a0af2",
  "branchId": "2ded358d-7450-4797-91c9-6b17122623b1",
  "cashierId": "fb610958-707f-469a-8758-84f38bf6717d",
  "provider": "CBE",
  "txnReference": "FT26282ND8WJ",
  "amount": "5",
  "expectedAmount": null,
  "receivingAccount": "1000076330763",
  "senderAccount": null,
  "payerPhone": null,
  "payerName": "Mr Bereket Terefe Ayele",
  "receiptUrl": null,
  "receiptImageUrl": "UPLOADED_FILE_PROOF",
  "status": "VERIFIED",
  "rawScannedText": "https://mbreciept.cbe.com.et/v2-hfHCxHzBg2algLIOtSGW",
  "verifiedAt": "2026-10-09T20:36:52.907Z"
}
```

**Success Response for Telebirr Image (`200 OK`)**
```json
{
  "id": "44b924ed-c3bf-4f99-af46-8c3ff0225eda",
  "branchId": "2ded358d-7450-4797-91c9-6b17122623b1",
  "cashierId": "fb610958-707f-469a-8758-84f38bf6717d",
  "provider": "TELEBIRR",
  "txnReference": "DJ66GTL8IY",
  "amount": "0",
  "expectedAmount": null,
  "receivingAccount": null,
  "senderAccount": null,
  "payerPhone": null,
  "payerName": null,
  "receiptUrl": null,
  "receiptImageUrl": "UPLOADED_FILE_PROOF",
  "status": "VERIFIED",
  "rawScannedText": "02360 008 NE lal 1%\n& Download «§ Share\nSuccessful\n-3 . 0 0 (ETB)\n...",
  "verifiedAt": "2026-10-09T20:37:05.409Z"
}
```


Part 1: Admin Sign Up & Login
1.1 Admin Register (Sign Up)
Method: POST
URL: {{BASE_URL}}/api/auth/register
Headers: Content-Type: application/json
Body (raw JSON):
json
{
  "fullName": "Dawit Haile",
  "phone": "0912345678",
  "pinCode": "4321",
  "accountType": "BUSINESS"
}

accountType can be "BUSINESS" or "PERSONAL". Phone accepts Ethiopian formats (09..., 07..., or +2519...). PIN must be exactly 4 digits.

Response (201 Created):
json
{
  "message": "Account created successfully",
  "token": "eyJhbGciOi...",
  "user": {
    "id": "593ae22a-0382-49c4-9394-afdbb282e860",
    "fullName": "Dawit Haile",
    "phone": "+251912345678",
    "role": "OWNER",
    "accountType": "BUSINESS",
    "organizationId": "8bcfcac1-b893-4716-8737-037471177cd2",
    "organizationName": "Dawit Haile's Business",
    "branchId": "e15033f8-27b8-4795-806e-2e6c7376bcab"
  }
}
1.2 Admin Login
Method: POST
URL: {{BASE_URL}}/api/auth/login
Headers: Content-Type: application/json
Body (raw JSON):
json
{
  "phone": "0912345678",
  "pinCode": "4321"
}
Response (200 OK):
json
{
  "message": "Login successful",
  "token": "eyJhbGciOi...",
  "user": {
    "id": "593ae22a-0382-49c4-9394-afdbb282e860",
    "fullName": "Dawit Haile",
    "phone": "+251912345678",
    "role": "OWNER",
    "organizationId": "8bcfcac1-b893-4716-8737-037471177cd2",
    "organizationName": "Dawit Haile's Business",
    "branchId": "e15033f8-27b8-4795-806e-2e6c7376bcab",
    "branchName": "Main Branch"
  }
}
Error Response (Wrong Phone/PIN - 401):
json
{
  "error": "Invalid phone or PIN"
}
1.3 Get Current User Profile (Admin or Cashier)
Method: GET
URL: {{BASE_URL}}/api/auth/me
Headers:
Authorization: Bearer <token>
Response for Admin (200 OK):
json
{
  "user": {
    "id": "593ae22a-0382-49c4-9394-afdbb282e860",
    "fullName": "Dawit Haile",
    "phone": "+251912345678",
    "role": "OWNER",
    "isAdmin": true,
    "organizationId": "8bcfcac1-b893-4716-8737-037471177cd2",
    "organizationName": "Dawit Haile's Business",
    "branchId": "e15033f8-27b8-4795-806e-2e6c7376bcab",
    "branchName": "Main Branch",
    "telegramLinked": false,
    "accountsCount": 2,
    "cashiersCount": 2
  }
}
1.4 Sign Out
Method: POST
URL: {{BASE_URL}}/api/auth/logout
Headers: Content-Type: application/json
Response (200 OK):
json
{
  "message": "Signed out successfully"
}
Part 2: Admin Receiving Accounts (CBE & Telebirr)

All endpoints in Part 2 require Admin JWT in the header (Authorization: Bearer <admin-token>).

2.1 Get All Accounts (Grouped by Bank)
Method: GET
URL: {{BASE_URL}}/api/settings/accounts
Headers: Authorization: Bearer <admin-token>
Response (200 OK):
json
{
  "accounts": [
    {
      "id": "3a5dffbc-7f22-40a5-9a70-759f7e56dedf",
      "bankName": "CBE",
      "accountNumber": "1000123456789",
      "accountHolderName": "Dawit Haile Bole",
      "isActive": true,
      "createdAt": "2026-11-07T19:48:11.482Z"
    },
    {
      "id": "7d67a8a8-6b78-4432-8476-cb2edfd2045c",
      "bankName": "TELEBIRR",
      "accountNumber": "0912345678",
      "accountHolderName": "Dawit Telebirr",
      "isActive": true,
      "createdAt": "2026-11-07T19:48:21.611Z"
    }
  ],
  "grouped": {
    "CBE": [
      {
        "id": "3a5dffbc-7f22-40a5-9a70-759f7e56dedf",
        "bankName": "CBE",
        "accountNumber": "1000123456789",
        "accountHolderName": "Dawit Haile Bole",
        "isActive": true
      }
    ],
    "TELEBIRR": [
      {
        "id": "7d67a8a8-6b78-4432-8476-cb2edfd2045c",
        "bankName": "TELEBIRR",
        "accountNumber": "0912345678",
        "accountHolderName": "Dawit Telebirr",
        "isActive": true
      }
    ]
  }
}
2.2 Add New Receiving Account
Method: POST
URL: {{BASE_URL}}/api/settings/accounts
Headers:
Authorization: Bearer <admin-token>
Content-Type: application/json

Example 1: CBE (13 digits required)

json
{
  "bankName": "CBE",
  "accountNumber": "1000123456789",
  "accountHolderName": "Dawit Haile Bole"
}

Example 2: Telebirr (Ethiopian phone number)

json
{
  "bankName": "TELEBIRR",
  "accountNumber": "0912345678",
  "accountHolderName": "Dawit Telebirr"
}
Response (201 Created):
json
{
  "message": "Receiving account added successfully",
  "account": {
    "id": "3a5dffbc-7f22-40a5-9a70-759f7e56dedf",
    "bankName": "CBE",
    "accountNumber": "1000123456789",
    "accountHolderName": "Dawit Haile Bole",
    "isActive": true
  }
}
2.3 Edit Account Holder Name
Method: PATCH
URL: {{BASE_URL}}/api/settings/accounts/:id
Headers:
Authorization: Bearer <admin-token>
Content-Type: application/json
Body (raw JSON):
json
{
  "accountHolderName": "Dawit Haile Main Branch"
}
Response (200 OK):
json
{
  "message": "Account updated successfully",
  "account": {
    "id": "3a5dffbc-7f22-40a5-9a70-759f7e56dedf",
    "accountHolderName": "Dawit Haile Main Branch",
    "isActive": true
  }
}
2.4 Toggle Account On/Off
Method: PATCH
URL: {{BASE_URL}}/api/settings/accounts/:id/toggle
Headers:
Authorization: Bearer <admin-token>
Content-Type: application/json
Body (raw JSON):
json
{
  "isActive": false
}
Response (200 OK):
json
{
  "message": "Account disabled successfully",
  "account": {
    "id": "3a5dffbc-7f22-40a5-9a70-759f7e56dedf",
    "isActive": false
  }
}
2.5 Delete Receiving Account
Method: DELETE
URL: {{BASE_URL}}/api/settings/accounts/:id
Headers: Authorization: Bearer <admin-token>
Response (200 OK):
json
{
  "message": "Account deleted successfully",
  "ok": true
}
Part 3: Admin Cashiers Management

Requires Admin JWT in the header (Authorization: Bearer <admin-token>).

3.1 List Cashiers
Method: GET
URL: {{BASE_URL}}/api/cashiers
Headers: Authorization: Bearer <admin-token>
Response (200 OK):
json
{
  "cashiers": [
    {
      "id": "b00b9e0a-c54d-4740-bbf4-343c3c2417da",
      "fullName": "Almaz Tadesse",
      "role": "CASHIER",
      "branchId": "e15033f8-27b8-4795-806e-2e6c7376bcab",
      "branchName": "Main Branch",
      "isActive": true,
      "createdAt": "2026-11-07T19:49:51.852Z"
    }
  ]
}
3.2 Add New Cashier (Branch & Business Auto-Assigned)
Method: POST
URL: {{BASE_URL}}/api/cashiers
Headers:
Authorization: Bearer <admin-token>
Content-Type: application/json
Body (raw JSON):
json
{
  "fullName": "Almaz Tadesse",
  "password": "almazPassword123"
}
Response (201 Created):
json
{
  "message": "Cashier created successfully",
  "cashier": {
    "id": "b00b9e0a-c54d-4740-bbf4-343c3c2417da",
    "fullName": "Almaz Tadesse",
    "role": "CASHIER",
    "branchId": "e15033f8-27b8-4795-806e-2e6c7376bcab",
    "branchName": "Main Branch",
    "isActive": true,
    "createdAt": "2026-11-07T19:49:51.852Z"
  }
}
Duplicate Password Error (409 Conflict):
json
{
  "error": "That password is already in use by another cashier in this branch. Please choose a different one."
}
3.3 Edit Cashier / Reset Password
Method: PATCH
URL: {{BASE_URL}}/api/cashiers/:id
Headers:
Authorization: Bearer <admin-token>
Content-Type: application/json
Body (raw JSON):
json
{
  "fullName": "Almaz T. Girma",
  "password": "newAlmazPass789"
}
Response (200 OK):
json
{
  "message": "Cashier updated successfully",
  "cashier": {
    "id": "b00b9e0a-c54d-4740-bbf4-343c3c2417da",
    "fullName": "Almaz T. Girma",
    "role": "CASHIER",
    "branchId": "e15033f8-27b8-4795-806e-2e6c7376bcab",
    "branchName": "Main Branch",
    "isActive": true,
    "createdAt": "2026-11-07T19:49:51.852Z"
  }
}
3.4 Enable or Disable a Cashier
Method: PATCH
URL: {{BASE_URL}}/api/cashiers/:id/status
Headers:
Authorization: Bearer <admin-token>
Content-Type: application/json
Body (raw JSON):
json
{
  "active": false
}
Response (200 OK):
json
{
  "message": "Cashier disabled successfully",
  "cashier": {
    "id": "b00b9e0a-c54d-4740-bbf4-343c3c2417da",
    "fullName": "Almaz T. Girma",
    "role": "CASHIER",
    "branchId": "e15033f8-27b8-4795-806e-2e6c7376bcab",
    "isActive": false
  }
}
3.5 Delete Cashier
Method: DELETE
URL: {{BASE_URL}}/api/cashiers/:id
Headers: Authorization: Bearer <admin-token>
Response (200 OK):
json
{
  "message": "Cashier removed successfully",
  "ok": true
}
Part 4: Cashier Login
4.1 Cashier Logs In (Password Only)
Method: POST
URL: {{BASE_URL}}/api/auth/cashier-login
Headers: Content-Type: application/json
Body (raw JSON):
json
{
  "password": "newAlmazPass789"
}

(Optional disambiguation: "fullName": "Almaz" or "branchId": "..." can also be passed).

Response (200 OK):
json
{
  "message": "Login successful",
  "token": "eyJhbGciOi...",
  "cashier": {
    "id": "b00b9e0a-c54d-4740-bbf4-343c3c2417da",
    "fullName": "Almaz T. Girma",
    "role": "CASHIER",
    "branchId": "e15033f8-27b8-4795-806e-2e6c7376bcab",
    "branchName": "Main Branch",
    "organizationId": "8bcfcac1-b893-4716-8737-037471177cd2",
    "organizationName": "Dawit Haile's Business"
  },
  "user": {
    "id": "b00b9e0a-c54d-4740-bbf4-343c3c2417da",
    "fullName": "Almaz T. Girma",
    "role": "CASHIER",
    "branchId": "e15033f8-27b8-4795-806e-2e6c7376bcab",
    "branchName": "Main Branch",
    "organizationId": "8bcfcac1-b893-4716-8737-037471177cd2",
    "organizationName": "Dawit Haile's Business"
  }
}
Wrong Password Response (401 Unauthorized):
json
{
  "error": "Wrong password, try again."
}
Part 5: Access Control & Payment Verification
5.1 Cashier Blocked From Admin Areas

If a Cashier calls GET /api/settings/accounts, POST /api/settings/accounts, GET /api/cashiers, etc.:

Response (403 Forbidden):
json
{
  "error": "This section is for business admins only."
}
5.2 Cashier Verifies Payment
Method: POST
URL: {{BASE_URL}}/api/verify/manual (or /api/verify/text, /api/verify/image, /api/verify/url)
Headers:
Authorization: Bearer <cashier-token>
Content-Type: application/json
Body (raw JSON):
json
{
  "provider": "CBE",
  "txnReference": "FT2600000001",
  "amount": 150.50
}
Response (200 OK):
json
{
  "status": "VERIFIED",
  "provider": "CBE",
  "txnReference": "FT2600000001",
  "amount": 150.5,
  "verifiedAt": "2026-11-07T19:52:59.000Z"
}