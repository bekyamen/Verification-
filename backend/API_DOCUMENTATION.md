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
