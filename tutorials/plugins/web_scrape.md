# web.scrape

This plugin downloads a web page and extracts structured data using CSS selectors or XPath expressions. It is ideal for monitoring price changes, gathering news headlines, or integrating website data that doesn't provide a public API.

## Prerequisites
* **Target URL:** A website that allows automated scraping (check `robots.txt` of the site).
* **DOM Structure Knowledge:** You should inspect the target page's HTML to identify the correct selectors.
* **Network Access:** The runner must have outbound internet access.
* **Testing Tool:** Use [JSONPlaceholder](https://jsonplaceholder.typicode.com/) or a static site like `https://example.com` for initial configuration tests.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `url` | The URL of the page to scrape. | `https://example.com/products` |
| `method` | HTTP method (`GET` or `POST`). | `GET` |
| `queries` | An array of extraction rules (see below). | `[{ "name": "title", "selector": "h1" }]` |
| `timeoutMs` | Request timeout in milliseconds. | `15000` |
| `baseUrl` | Used to resolve relative links. | `https://example.com` |

### Query Object Properties
| Property | Description |
| :--- | :--- |
| `name` | The key in the output results object. |
| `type` | `css` (default) or `xpath`. |
| `selector` | The CSS or XPath string. |
| `extract` | What to pull: `text` (default), `html`, `outerHTML`, or `attr`. |
| `attr` | The attribute name (e.g., `href`, `src`) if `extract` is `attr`. |
| `all` | If `true`, returns an array of all matches; otherwise only the first. |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `status` | The HTTP response code. | `200` |
| `results` | An object containing the extracted data. | `{"title": "Welcome", "links": ["/a", "/b"]}` |

## Sample workflow
```yaml
name: product-price-tracker
description: |
  Scrapes a product page to extract the name and price, 
  then logs the result.

nodes:
  - name: scrape_product
    action: web.scrape
    inputs:
      - url: "https://example.com/item/123"
      - queries:
          - name: productName
            selector: "h1.product-title"
          - name: price
            selector: "//span[@class='price']/text()"
            type: "xpath"
          - name: image
            selector: "img#main-pic"
            attr: "src"
    outputs:
      - results: scrapedData

  - name: log_price
    action: log
    inputs:
      - message: "Product: ${scrapedData.productName} is currently ${scrapedData.price}"

edges:
  - from: scrape_product
    to: log_price
```

## Expected output
If the selectors match the page content, the plugin returns:
```json
{
  "url": "https://example.com/item/123",
  "status": 200,
  "results": {
    "productName": "Wireless Headphones",
    "price": "$99.99",
    "image": "https://example.com/images/hp123.jpg"
  }
}
```

## Troubleshooting
* **User-Agent Blocking:** Some websites block the default scraper User-Agent. You can override this by passing a custom `headers` input with a standard browser User-Agent.
* **JavaScript Dependency:** This plugin uses `jsdom`, which does not execute client-side JavaScript. If the data is rendered by a framework like React or Vue *after* the page loads, this plugin may return empty results.
* **XPath Errors:** Ensure your XPath expressions are valid. If a specific query fails, the plugin will return an `__error` key inside that specific result rather than failing the entire node.

## Library
* `jsdom` - A pure-JavaScript implementation of many web standards for use with Node.js.

## Reference
* [MDN CSS Selectors Guide](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Selectors)
* [MDN XPath Documentation](https://developer.mozilla.org/en-US/docs/Web/XPath)
