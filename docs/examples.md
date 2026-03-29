# Examples

Here are some examples of programms using the language.

```
import env pow i32 i32 => i32

export add i32 i32 => i32
get 0
get 1
add i32
return

export square i32 => i32
get 0
get 0
mul i32
return

export isZero i32 => i32
get 0
if i32
  const i32 0
else
  const i32 1
end
return

export pow i32 i32 => i32
get 0
get 1
call 0
return
```