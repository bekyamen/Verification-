Here are the specific mock data payloads you can use in Postman to test CBE, Telebirr, and Dashen across the three different verification methods.

(Don't forget to include your Authorization and PIN headers for each request as outlined previously!)

Method 1: Verify via Text (POST /verify/text)
Make sure to select raw -> JSON in the Postman body tab.

Test 1: CBE (Commercial Bank of Ethiopia)

json
{
  "rawText": "Dear Customer, you have transferred ETB 500.00 to CheckFlow Branch on 10/05/2026. Ref: FT9A3BC8Z",
  "expectedAmount": 500.00
}
Test 2: Telebirr

json
{
  "rawText": "Dear customer, you have transferred 1,000 Birr to CheckFlow. Transaction ID: TEC2345678. Date: 10/05/2026",
  "expectedAmount": 1000.00
}
Test 3: Dashen Bank

json
{
  "rawText": "Dashen Bank: You have successfully transferred ETB 250.00 to account 1000XXXX. Ref: DSH987654321.",
  "expectedAmount": 250.00
}
Method 2: Verify via Image / PDF (POST /verify/image)
Make sure to select form-data in the Postman body tab.

Because this endpoint relies on OCR (reading text from the image), you can't just send JSON. Here is exactly how to test it:

Find or take 3 screenshots/photos:
One of a CBE mobile banking receipt.
One of a Telebirr transfer confirmation screen.
One of a Dashen Bank receipt.
In Postman, set up the form-data keys:
Key: receipt (Set type to File) -> Value: Upload your CBE screenshot.
Key: expectedAmount (Set type to Text) -> Value: (Whatever the total is on that CBE screenshot).
Click send.
Repeat the process by swapping out the receipt file with your Telebirr and Dashen images, updating the expectedAmount accordingly. The dissectPayload engine will automatically figure out which bank it is!
Method 3: Verify Manually (POST /verify/manual)
Make sure to select raw -> JSON in the Postman body tab.

This method forces the verification engine to bypass parsing and directly hit the bank APIs to verify the provided exact data.

Test 1: CBE Manual Verification

json
{
  "provider": "CBE",
  "txnReference": "FT9A3BC8Z",
  "amount": 500.00,
  "expectedAmount": 500.00,
  "receivingAccount": "1000123456789",
  "senderAccount": "1000987333211",
  "payerPhone": ""
}
Test 2: Telebirr Manual Verification

json
{
  "provider": "TELEBIRR",
  "txnReference": "TEC2345678",
  "amount": 1000.00,
  "expectedAmount": 1000.00,
  "receivingAccount": "0911000000",
  "senderAccount": "0911223344",
  "payerPhone": "0911223344"
}
Test 3: Dashen Bank Manual Verification

json
{
  "provider": "DASHEN",
  "txnReference": "DSH987654321",
  "amount": 250.00,
  "expectedAmount": 250.00,
  "receivingAccount": "001122334455",
  "senderAccount": "",
  "payerPhone": ""
}
