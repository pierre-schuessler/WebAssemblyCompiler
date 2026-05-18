# File structure

1. Services
1.1.
1.2. Any amount of sub-services 
1.3. Documentation
2. Service-specific code
3. Macro code

# Example

```
// DECLARATION //
@service1
endpoint1 : (int32) (int32) (int32) => (int32)


// SERVICES //
@service1
endpoint endpoint1 (a, b, c)
{
    temp = add(a, b)
    temp = sub(temp, c)
    return (temp)
}

function sub (int32 a, int32 b)
{
    return (a - b)
}

// MACROS //
add (int32 a, int32 b)
{
    return (a + b)
}
```