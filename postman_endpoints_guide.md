# CheckFlow ET Backend API - Postman Testing Guide

Here is the complete list of APIs available in your backend, formatted with the exact headers and body payloads you need to test them in Postman.

> [!NOTE] 
> **Base URL**: Set your Postman base URL to `http://localhost:5000` (or whatever port your server runs on).

---

## 1. Authentication Endpoints


### Register User
**POST** `/api/auth/register`
* **Headers**: `Content-Type: application/json`
* **Body**:
  ```json
  {
    "fullName": "Abebe Kebede",
    "phone": "0911223344",
    "pinCode": "1234",
    "accountType": "BUSINESS" // Can be "BUSINESS" or "PERSONAL"
  }
  ```
_Note: On successful registration, it returns user details (including the `branchId`) and a token. Save the `branchId` for the verification headers later!_

### Login User
**POST** `/api/auth/login`
* **Headers**: `Content-Type: application/json`
* **Body**:
  ```json
  {
    "phone": "0911223344",
    "pinCode": "1234"
  }

  ```
_Note: In Postman, save the generated JWT token to use in the Authorization header for reports._

---

## 2. Verification Endpoints (Cashier Actions)

> [!IMPORTANT]
> All verification endpoints require these two headers to authenticate shared counter tablets:
> - `x-cashier-pin`: e.g. `1234`
> - `x-branch-id`: The `branchId` GUID you got from login/registration

### Verify via Text Payload (SMS/USSD)
**POST** `/api/verify/text`
* **Headers**: 
  - `x-cashier-pin`: `1234`
  - `x-branch-id`: `YOUR_BRANCH_ID`
  - `Content-Type`: `application/json`
* **Body**: 
  ```json

  {
    "rawText": "Sent 500 ETB to...",
    "expectedAmount": 500 // Optional
  }

  ```

### Verify via Image/PDF (Receipt Upload)
**POST** `/api/verify/image`
* **Headers**:
  - `x-cashier-pin`: `1234`
  - `x-branch-id`: `YOUR_BRANCH_ID`
* **Body (form-data)**: 
  Choose `multipart/form-data` (or standard `form-data` tab) in Postman.
  - Key: `receipt` (Type: **File**), Value: Select an image or PDF.
  - Key: `expectedAmount` (Type: **Text**), Value: `500` (Optional)

### Verify via URL
**POST** `/api/verify/url`
* **Headers**:
  - `x-cashier-pin`: `1234`
  - `x-branch-id`: `YOUR_BRANCH_ID`
  - `Content-Type`: `application/json`
* **Body**:
  ```json
  {
    "receiptUrl": "http://example.com/some/receipt/link",
    "expectedAmount": 500 // Optional
  }

  ```

  

### Verify via Manual Data Entry
**POST** `/api/verify/manual`
* **Headers**:
  - `x-cashier-pin`: `1234`
  - `x-branch-id`: `YOUR_BRANCH_ID`
  - `Content-Type`: `application/json`
* **Body**:
  ```json
  {
    "provider": "CBE", 
    "txnReference": "FT123456789",
    "amount": 500,
    "expectedAmount": 500, // Optional
    "receivingAccount": "1000123456789",
    "senderAccount": "",
    "payerPhone": ""
  }
  ```
> [!TIP]
> **Validation Rules for Manual Data Entry:**
> - **`provider`** MUST be one of: `"CBE", "TELEBIRR", "DASHEN", "AWASH", "BOA", "ZEMEN", "CBE_BIRR", "MPESA", "SIINQEE", "OTHER", "UNKNOWN"`
> - **`receivingAccount`**: Required for `CBE`, must be at least 10 digits.
> - **`senderAccount`**: Required for `BOA`, must be at least 5 digits.
> - **`payerPhone`**: Required for `CBE_BIRR`, must start with `251`.


---

## 3. Manager/Owner Reports

### Daily Excel Report Download
**GET** `/api/reports/daily`
* **Headers**: 
  - `Authorization`: `Bearer <YOUR_JWT_TOKEN>`

---

## 4. Others

### Health Check (No Auth needed)
**GET** `/api/health`

