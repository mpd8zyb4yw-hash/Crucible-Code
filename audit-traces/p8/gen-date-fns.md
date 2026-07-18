```javascript
import { parse } from 'date-fns';

const formattedDate = parse('28-a de februaro', "do 'de' MMMM", new Date(2010, 0, 1), { locale: 'eo' });
console.log(formattedDate);
```

---
Sources:
[S1] date-fns@4.4.0 — published type definitions (authoritative API surface) — https://www.npmjs.com/package/date-fns/v/4.4.0