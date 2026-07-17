```javascript
import axios from 'axios';

const url = 'https://www.example.com/data';

axios.get(url)
  .then(response => {
    console.log('Success:', response.data);
  })
  .catch(error => {
    console.error('Error:', error);
  });
```

---
Sources:
[S1] axios@1.18.1 — published type definitions (authoritative API surface) — https://www.npmjs.com/package/axios/v/1.18.1