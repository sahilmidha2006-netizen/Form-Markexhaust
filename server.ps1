$ErrorActionPreference = "Stop"

$username = "admin"
$passwordSecure = $null
if (-not [string]::IsNullOrWhiteSpace($env:PARTY_ADMIN_PASSWORD)) {
    $password = $env:PARTY_ADMIN_PASSWORD
    Remove-Item Env:\PARTY_ADMIN_PASSWORD
}
else {
    $passwordSecure = Read-Host "Set the admin password for this run" -AsSecureString
    $password = [System.Net.NetworkCredential]::new("", $passwordSecure).Password
}
if ([string]::IsNullOrWhiteSpace($password) -or $password.Length -lt 12) {
    throw "Use an admin password with at least 12 characters."
}

$partyFields = @("party code", "party name", "party add1", "party add 2", "city", "state", "pin", "state 1", "status", "md/td")
$partyDataPath = Join-Path $PSScriptRoot "parties.json"
if (-not (Test-Path -LiteralPath $partyDataPath)) {
    throw "Party data file not found: parties.json"
}

$partyRows = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($partyDataPath, [System.Text.Encoding]::UTF8))
$loadedRecords = New-Object "System.Collections.Generic.List[object]"
foreach ($row in $partyRows) {
    $record = [ordered]@{}
    foreach ($field in $partyFields) {
        $property = $row.PSObject.Properties[$field]
        if ($null -eq $property) {
            throw "Party data is missing the required '$field' column."
        }
        $record[$field] = [string]$property.Value
    }
    $loadedRecords.Add($record)
}
$records = $loadedRecords.ToArray()
if ($records.Count -eq 0) {
    throw "Party data file contains no records."
}
if (@($records | Group-Object { $_["party code"] } | Where-Object Count -gt 1).Count -gt 0) {
    throw "Party data contains duplicate party codes."
}

$productFields = @("part number", "product code", "product name", "mrp", "md price", "td price")
$productDataPath = Join-Path $PSScriptRoot "products.json"
if (-not (Test-Path -LiteralPath $productDataPath)) {
    throw "Product data file not found: products.json"
}

$productRows = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($productDataPath, [System.Text.Encoding]::UTF8))
$productList = New-Object "System.Collections.Generic.List[object]"
$productByPart = @{}
foreach ($row in $productRows) {
    $product = [ordered]@{}
    foreach ($field in $productFields) {
        $property = $row.PSObject.Properties[$field]
        if ($null -eq $property) {
            throw "Product data is missing the required '$field' column."
        }
        $product[$field] = $property.Value
    }
    $partNumber = [string]$product["part number"]
    if ([string]::IsNullOrWhiteSpace($partNumber) -or $productByPart.ContainsKey($partNumber)) {
        throw "Product data contains an empty or duplicate part number."
    }
    $productByPart[$partNumber] = $product
    $productList.Add($product)
}
$products = $productList.ToArray()
if ($products.Count -eq 0) {
    throw "Product data file contains no products."
}

$dataPath = Join-Path $PSScriptRoot "submissions.json"
$sessions = @{}
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:8787/")

function Send-Response {
    param(
        [System.Net.HttpListenerContext]$Context,
        [int]$StatusCode,
        [string]$ContentType,
        [byte[]]$Body,
        [string[]]$ExtraHeaders = @()
    )

    $response = $Context.Response
    $response.StatusCode = $StatusCode
    $response.ContentType = $ContentType
    $response.ContentLength64 = $Body.Length
    $response.Headers.Add("Cache-Control", "no-store")
    foreach ($header in $ExtraHeaders) {
        $response.Headers.Add("Set-Cookie", $header)
    }
    if ($Body.Length -gt 0) {
        $response.OutputStream.Write($Body, 0, $Body.Length)
    }
    $response.Close()
}

function Send-Json {
    param(
        [System.Net.HttpListenerContext]$Context,
        [int]$StatusCode,
        [object]$Value,
        [string[]]$ExtraHeaders = @()
    )

    $json = ConvertTo-Json -InputObject $Value -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Send-Response -Context $Context -StatusCode $StatusCode -ContentType "application/json; charset=utf-8" -Body $bytes -ExtraHeaders $ExtraHeaders
}

function Read-RequestJson {
    param([System.Net.HttpListenerRequest]$Request)

    if ($Request.ContentLength64 -gt 65536) {
        throw "Request is too large."
    }
    $reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
    try {
        $body = $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($body)) {
        throw "Request body is required."
    }
    return ($body | ConvertFrom-Json)
}

function Read-Submissions {
    $items = @()
    if (-not (Test-Path -LiteralPath $dataPath)) {
        return [pscustomobject]@{ Items = $items }
    }
    $content = [System.IO.File]::ReadAllText($dataPath, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($content)) {
        return [pscustomobject]@{ Items = $items }
    }
    $document = ConvertFrom-Json -InputObject $content
    if ($document.PSObject.Properties.Name -contains "submissions") {
        $items = @($document.submissions)
    }
    else {
        $items = @($document)
    }
    return [pscustomobject]@{ Items = $items }
}

function Save-Submissions {
    param([object[]]$Items)

    $document = [ordered]@{ submissions = @($Items) }
    $json = ConvertTo-Json -InputObject $document -Depth 10
    $temporaryPath = "$dataPath.tmp"
    [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $dataPath -Force
}

function Get-SessionToken {
    param([System.Net.HttpListenerContext]$Context)

    $cookie = $Context.Request.Cookies["admin_session"]
    if ($null -eq $cookie) {
        return $null
    }
    $token = $cookie.Value
    if (-not $sessions.ContainsKey($token)) {
        return $null
    }
    if ($sessions[$token] -lt [DateTime]::UtcNow) {
        $sessions.Remove($token)
        return $null
    }
    return $token
}

function Get-SafeErrorMessage {
    param([System.Exception]$Exception)

    if ($Exception.Message -in @("Request body is required.", "Request is too large.")) {
        return $Exception.Message
    }
    return "Invalid request."
}

$listener.Start()
Write-Host "Party form running at http://127.0.0.1:8787/"
Write-Host "Admin panel: http://127.0.0.1:8787/admin"
Write-Host "Press Ctrl+C to stop the server. Submissions are saved in submissions.json."

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $path = $request.Url.AbsolutePath
        $method = $request.HttpMethod

        try {
            foreach ($expiredToken in @($sessions.Keys)) {
                if ($sessions[$expiredToken] -lt [DateTime]::UtcNow) {
                    [void]$sessions.Remove($expiredToken)
                }
            }

            if ($method -eq "GET" -and $path -in @("/", "/admin")) {
                $fileName = if ($path -eq "/") { "index.html" } else { "admin.html" }
                $filePath = Join-Path $PSScriptRoot $fileName
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                Send-Response -Context $context -StatusCode 200 -ContentType "text/html; charset=utf-8" -Body $bytes
                continue
            }

            if ($method -eq "GET" -and $path -eq "/api/parties") {
                Send-Json -Context $context -StatusCode 200 -Value @($records)
                continue
            }

            if ($method -eq "GET" -and $path -eq "/api/products") {
                $partyCode = [string]$request.QueryString["partyCode"]
                $query = ([string]$request.QueryString["q"]).Trim()
                $party = $records | Where-Object { $_["party code"] -ceq $partyCode } | Select-Object -First 1
                if ($null -eq $party) {
                    Send-Json -Context $context -StatusCode 400 -Value @{ error = "Select a valid party before searching products." }
                    continue
                }
                $priceType = ([string]$party["md/td"]).Trim().ToUpperInvariant()
                if ($priceType -notin @("MD", "TD")) {
                    Send-Json -Context $context -StatusCode 400 -Value @{ error = "This party has no valid MD/TD price type." }
                    continue
                }

                $priceField = if ($priceType -eq "MD") { "md price" } else { "td price" }
                $matches = New-Object "System.Collections.Generic.List[object]"
                foreach ($product in $products) {
                    $isMatch = ([string]$product["part number"]).IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                        ([string]$product["product code"]).IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                        ([string]$product["product name"]).IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
                    if (-not $isMatch) {
                        continue
                    }

                    $matches.Add([ordered]@{
                        "part number" = $product["part number"]
                        "product code" = $product["product code"]
                        "product name" = $product["product name"]
                        mrp = $product["mrp"]
                        price = $product[$priceField]
                        "price type" = $priceType
                    })
                    if ($query.Length -gt 0 -and $matches.Count -ge 40) {
                        break
                    }
                }
                Send-Json -Context $context -StatusCode 200 -Value $matches.ToArray()
                continue
            }

            if ($method -eq "POST" -and $path -eq "/api/submissions") {
                $payload = Read-RequestJson -Request $request
                $partyCode = [string]$payload.'party code'
                $party = $records | Where-Object { $_["party code"] -ceq $partyCode } | Select-Object -First 1
                if ($null -eq $party) {
                    Send-Json -Context $context -StatusCode 400 -Value @{ error = "Select a valid party before submitting." }
                    continue
                }

                $requestedProducts = @($payload.products)
                if ($requestedProducts.Count -lt 1 -or $requestedProducts.Count -gt 50) {
                    Send-Json -Context $context -StatusCode 400 -Value @{ error = "Add between 1 and 50 products before submitting." }
                    continue
                }

                $priceType = ([string]$party["md/td"]).Trim().ToUpperInvariant()
                if ($priceType -notin @("MD", "TD")) {
                    Send-Json -Context $context -StatusCode 400 -Value @{ error = "This party has no valid MD/TD price type." }
                    continue
                }
                $priceField = if ($priceType -eq "MD") { "md price" } else { "td price" }
                $submittedProducts = New-Object "System.Collections.Generic.List[object]"
                $productValidationError = $null
                foreach ($requestedProduct in $requestedProducts) {
                    $partNumber = [string]$requestedProduct.'part number'
                    if ([string]::IsNullOrWhiteSpace($partNumber) -or -not $productByPart.ContainsKey($partNumber)) {
                        $productValidationError = "A submitted product is not in the product list."
                        break
                    }

                    [decimal]$quantity = 0
                    $validQuantity = [decimal]::TryParse(
                        [System.Convert]::ToString($requestedProduct.quantity, [System.Globalization.CultureInfo]::InvariantCulture),
                        [System.Globalization.NumberStyles]::Number,
                        [System.Globalization.CultureInfo]::InvariantCulture,
                        [ref]$quantity
                    )
                    if (-not $validQuantity -or $quantity -le 0 -or $quantity -gt 10000000) {
                        $productValidationError = "Product quantity must be greater than 0 and no more than 10,000,000."
                        break
                    }

                    $product = $productByPart[$partNumber]
                    $submittedProducts.Add([ordered]@{
                        "part number" = $product["part number"]
                        "product code" = $product["product code"]
                        "product name" = $product["product name"]
                        mrp = $product["mrp"]
                        "price type" = $priceType
                        price = $product[$priceField]
                        quantity = $quantity
                    })
                }
                if ($productValidationError) {
                    Send-Json -Context $context -StatusCode 400 -Value @{ error = $productValidationError }
                    continue
                }

                $storedSubmissions = Read-Submissions
                $submissions = @($storedSubmissions.Items)
                $submission = [ordered]@{}
                foreach ($key in $party.Keys) {
                    $submission[$key] = $party[$key]
                }
                $submission["products"] = $submittedProducts.ToArray()
                $submission["submitted at"] = [DateTime]::UtcNow.ToString("o")
                $submissions += $submission
                Save-Submissions -Items $submissions
                Send-Json -Context $context -StatusCode 201 -Value @{ message = "Submission received." }
                continue
            }

            if ($method -eq "POST" -and $path -eq "/api/admin/login") {
                $payload = Read-RequestJson -Request $request
                $providedUsername = [string]$payload.username
                $providedPassword = [string]$payload.password
                if ($providedUsername -cne $username -or $providedPassword -cne $password) {
                    Send-Json -Context $context -StatusCode 401 -Value @{ error = "Incorrect username or password." }
                    continue
                }

                $randomBytes = New-Object byte[] 32
                $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
                try {
                    $generator.GetBytes($randomBytes)
                }
                finally {
                    $generator.Dispose()
                }
                $token = [Convert]::ToBase64String($randomBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
                $sessions[$token] = [DateTime]::UtcNow.AddHours(8)
                $cookie = "admin_session=$token; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=28800"
                Send-Json -Context $context -StatusCode 200 -Value @{ message = "Signed in." } -ExtraHeaders @($cookie)
                continue
            }

            if ($method -eq "GET" -and $path -eq "/api/admin/session") {
                $token = Get-SessionToken -Context $context
                Send-Json -Context $context -StatusCode 200 -Value @{ authenticated = [bool]$token }
                continue
            }

            if ($path -like "/api/admin/*") {
                $token = Get-SessionToken -Context $context
                if (-not $token) {
                    Send-Json -Context $context -StatusCode 401 -Value @{ error = "Admin sign-in required." } -ExtraHeaders @("admin_session=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0")
                    continue
                }

                if ($method -eq "GET" -and $path -eq "/api/admin/submissions") {
                    $storedSubmissions = Read-Submissions
                    $submissionJson = ConvertTo-Json -InputObject @($storedSubmissions.Items) -Depth 10
                    $submissionBytes = [System.Text.Encoding]::UTF8.GetBytes($submissionJson)
                    Send-Response -Context $context -StatusCode 200 -ContentType "application/json; charset=utf-8" -Body $submissionBytes
                    continue
                }

                if ($method -eq "POST" -and $path -eq "/api/admin/logout") {
                    $sessions.Remove($token)
                    $expiredCookie = "admin_session=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0"
                    Send-Json -Context $context -StatusCode 200 -Value @{ message = "Signed out." } -ExtraHeaders @($expiredCookie)
                    continue
                }
            }

            Send-Json -Context $context -StatusCode 404 -Value @{ error = "Not found." }
        }
        catch {
            Write-Error $_
            $message = Get-SafeErrorMessage -Exception $_.Exception
            try {
                Send-Json -Context $context -StatusCode 500 -Value @{ error = $message }
            }
            catch {
                $context.Response.Abort()
            }
        }
    }
}
finally {
    $listener.Stop()
    $listener.Close()
    $password = $null
    if ($null -ne $passwordSecure) {
        $passwordSecure.Dispose()
    }
}
